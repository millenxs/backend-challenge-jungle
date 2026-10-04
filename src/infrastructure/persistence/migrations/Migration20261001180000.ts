import { Migration } from "@mikro-orm/migrations";

export class Migration20261001180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance_amount numeric(19, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(64) not null,
        external_transaction_id varchar(128) not null,
        idempotency_key varchar(256) not null,
        payload_hash varchar(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(128) not null,
        game_id varchar(128) not null,
        kind varchar(16) not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(128) null,
        created_at timestamptz not null,
        status varchar(32) not null,
        reference_transaction_id uuid null,
        failure_code varchar(64) null,
        processed_at timestamptz null,
        retry_attempts integer not null default 0,
        next_attempt_at timestamptz null,
        balance_after_amount numeric(19, 2) null,
        constraint wager_transactions_idempotency_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_kind_check check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_check check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_refund_rollback_requires_reference check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
        )
      );
    `);

    this.addSql(`
      create unique index wager_transactions_refund_once
        on wager_transactions (reference_transaction_id)
        where kind = 'REFUND' and status = 'PROCESSED';
    `);

    this.addSql(`
      create unique index wager_transactions_rollback_once
        on wager_transactions (reference_transaction_id)
        where kind = 'ROLLBACK' and status = 'PROCESSED';
    `);

    this.addSql(`
      create index wager_transactions_pending_ref
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction varchar(8) not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        balance_before_amount numeric(19, 2) not null,
        balance_after_amount numeric(19, 2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_unique unique (transaction_id),
        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_arithmetic_check check (
          (direction = 'DEBIT' and balance_after_amount = balance_before_amount - amount) or
          (direction = 'CREDIT' and balance_after_amount = balance_before_amount + amount)
        ),
        constraint wallet_ledger_entries_balance_non_negative check (balance_after_amount >= 0)
      );
    `);

    this.addSql(`
      create function prevent_ledger_mutation()
      returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is immutable';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_prevent_update
        before update on wallet_ledger_entries
        for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_prevent_delete
        before delete on wallet_ledger_entries
        for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create index wallet_ledger_entries_wallet_cursor
        on wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(64) not null,
        message_id varchar(128) not null,
        payload_hash varchar(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id varchar(64) not null,
        event_type varchar(64) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null
      );
    `);

    this.addSql(`
      create index outbox_messages_due
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop trigger if exists wallet_ledger_entries_prevent_delete on wallet_ledger_entries;");
    this.addSql("drop trigger if exists wallet_ledger_entries_prevent_update on wallet_ledger_entries;");
    this.addSql("drop function if exists prevent_ledger_mutation;");
    this.addSql("drop table if exists outbox_messages;");
    this.addSql("drop table if exists inbox_messages;");
    this.addSql("drop table if exists wallet_ledger_entries;");
    this.addSql("drop table if exists wager_transactions;");
    this.addSql("drop table if exists wallets;");
  }
}
