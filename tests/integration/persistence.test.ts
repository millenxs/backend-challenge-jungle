import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { WageringService } from "../../src/application/wagering.service";
import { WalletService } from "../../src/application/wallet.service";
import { expectLedgerMatchesBalance, ledgerCount, openDb, rejectionOf, sql, uuid, wager } from "../support";

let orm: MikroORM;
let wallets: WalletService;
let wagering: WageringService;

beforeAll(async () => {
  orm = await openDb();
  wallets = new WalletService(orm);
  wagering = new WageringService(orm);
});
afterAll(() => orm.close(true));

const newWallet = async (amount = "100.00") => {
  const playerId = uuid();
  const created = await wallets.create({ playerId, initialBalance: { amount, currency: "BRL" } }, "test");
  return { id: created.id, playerId };
};
const submit = (body: ReturnType<typeof wager>): Promise<Record<string, any>> =>
  wagering.submit(`${body.providerId}:${body.externalTransactionId}`, body as never, { correlationId: "test", source: "http" });

describe("migrations and constraints", () => {
  test("migrations are applied and reversible objects exist", async () => {
    const tables = await sql<{ table_name: string }>(
      orm,
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual(
      expect.arrayContaining(["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"]),
    );
  });

  test("migration is reversible: up → down → up on a throwaway database", async () => {
    const dbName = `wager_migration_check_${uuid().slice(0, 8)}`;
    await sql(orm, `create database ${dbName}`);
    const scratch = await MikroORM.init({ ...createMikroOrmConfig(), dbName });
    const tables = async () =>
      (
        await sql<{ table_name: string }>(
          scratch,
          "select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1",
        )
      ).map((t) => t.table_name);
    const expected = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];
    try {
      await scratch.getMigrator().up();
      expect(await tables()).toEqual(expected);
      await scratch.getMigrator().down();
      expect(await tables()).toEqual([]);
      const [leftovers] = await sql<{ triggers: number; functions: number }>(
        scratch,
        `select (select count(*)::int from pg_trigger where not tgisinternal) as triggers,
                (select count(*)::int from pg_proc where proname = 'prevent_ledger_mutation') as functions`,
      );
      expect(leftovers).toEqual({ triggers: 0, functions: 0 });
      await scratch.getMigrator().up();
      expect(await tables()).toEqual(expected);
    } finally {
      await scratch.close(true);
      await sql(orm, `drop database ${dbName}`);
    }
  });

  test("ledger is immutable: UPDATE, DELETE and TRUNCATE are refused by the database", async () => {
    const wallet = await newWallet();
    expect(await rejectionOf(sql(orm, "update wallet_ledger_entries set amount = 1 where wallet_id = ?", [wallet.id]))).toMatch(/immutable/);
    expect(await rejectionOf(sql(orm, "delete from wallet_ledger_entries where wallet_id = ?", [wallet.id]))).toMatch(/immutable/);
    expect(await rejectionOf(sql(orm, "truncate wallet_ledger_entries cascade"))).toMatch(/immutable/);
    expect(await ledgerCount(orm, wallet.id)).toBe(1);
  });

  test("balance can never be negative, even bypassing the application", async () => {
    const wallet = await newWallet();
    expect(await rejectionOf(sql(orm, "update wallets set balance_amount = -0.01 where id = ?", [wallet.id]))).toMatch(/wallets_balance_non_negative/);
  });

  test("one wallet per player and currency", async () => {
    const wallet = await newWallet();
    expect(await rejectionOf(wallets.create({ playerId: wallet.playerId, initialBalance: { amount: "1.00", currency: "BRL" } }, "test"))).toMatch(/already exists/);
  });

  test("ledger arithmetic is checked by the database", async () => {
    const wallet = await newWallet();
    const [tx] = await sql<{ id: string }>(orm, "select id from wager_transactions where wallet_id = ?", [wallet.id]);
    expect(await rejectionOf(sql(
        orm,
        `insert into wallet_ledger_entries values (?, ?, ?, 'DEBIT', 25, 'BRL', 100, 80, now())`,
        [uuid(), wallet.id, tx!.id],
      ),)).toMatch(/arithmetic_check|transaction_unique/);
  });

  test("a reference cannot be refunded twice (partial unique index)", async () => {
    const wallet = await newWallet();
    const bet = wager(wallet, "BET", "10.00");
    await submit(bet);
    const refund = (id: string) => wager(wallet, "REFUND", "10.00", { externalTransactionId: id, referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(refund(`r-${uuid()}`))).status).toBe("PROCESSED");
    const second = await submit(refund(`r-${uuid()}`));
    expect(second).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
    // E mesmo forçando direto no banco, o índice parcial barra a segunda reversão processada.
    const [first] = await sql<{ reference_transaction_id: string }>(
      orm,
      "select reference_transaction_id from wager_transactions where wallet_id = ? and kind = 'REFUND' and status = 'PROCESSED'",
      [wallet.id],
    );
    expect(await rejectionOf(sql(orm, "update wager_transactions set status = 'PROCESSED', reference_transaction_id = ? where id = ?", [
        first!.reference_transaction_id,
        second.transactionId,
      ]),)).toMatch(/refund_once/);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });
});

describe("atomicity between wallet, ledger, inbox and outbox", () => {
  test("a failure before commit leaves no trace in any table", async () => {
    const wallet = await newWallet();
    const bet = wager(wallet, "BET", "30.00");
    const messageId = `msg-${uuid()}`;
    process.env.FAULT_INJECT = "before-commit";
    try {
      expect(await rejectionOf(wagering.submit(`${bet.providerId}:${bet.externalTransactionId}`, bet as never, {
          correlationId: "test",
          source: "sqs",
          inbox: { consumerName: "test", messageId, payloadHash: "h" },
        }),)).toMatch(/fault injected/);
    } finally {
      delete process.env.FAULT_INJECT;
    }
    const [counts] = await sql<Record<string, number>>(
      orm,
      `select
         (select count(*)::int from wager_transactions where external_transaction_id = ?) as transactions,
         (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger,
         (select count(*)::int from inbox_messages where message_id = ?) as inbox,
         (select count(*)::int from outbox_messages where aggregate_id = ?) as outbox,
         (select version from wallets where id = ?) as version`,
      [bet.externalTransactionId, wallet.id, messageId, wallet.id, wallet.id],
    );
    // outbox de abertura (WalletBalanceChanged) pertence à wallet; nenhum evento novo foi gravado
    expect(counts).toEqual({ transactions: 0, ledger: 1, inbox: 0, outbox: 1, version: 1 });

    // Sem a falha, o mesmo pedido é aplicado uma única vez, com tudo junto.
    const result = await submit(bet);
    expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "70.00", currency: "BRL" } });
    const events = await sql<{ event_type: string }>(
      orm,
      "select event_type from outbox_messages where aggregate_id in (?, ?) order by event_type",
      [wallet.id, result.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged", "WalletBalanceChanged"]);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("wallet opening writes wallet, OPENING transaction, CREDIT entry and events together", async () => {
    const wallet = await newWallet("1000.00");
    const [row] = await sql<Record<string, unknown>>(
      orm,
      `select t.kind, t.status, l.direction, l.amount::text as amount, w.version
         from wallets w
         join wager_transactions t on t.wallet_id = w.id
         join wallet_ledger_entries l on l.transaction_id = t.id
        where w.id = ?`,
      [wallet.id],
    );
    expect(row).toEqual({ kind: "OPENING", status: "PROCESSED", direction: "CREDIT", amount: "1000.00", version: 1 });
    const zero = await newWallet("0.00");
    expect(await ledgerCount(orm, zero.id)).toBe(0);
    await expectLedgerMatchesBalance(orm, [wallet.id, zero.id]);
  });
});
