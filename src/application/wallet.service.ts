import { Injectable } from "@nestjs/common";
import { MikroORM, UniqueConstraintViolationException } from "@mikro-orm/core";
import { DuplicateWalletError, ValidationError, WalletNotFoundError } from "../domain/errors";
import { WagerTransactionProcessed, WalletBalanceChanged } from "../domain/events/wagering-events";
import { Money, type MoneyProps } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { log, metrics } from "../infrastructure/observability";
import {
  ledgerToDomain,
  ledgerToRecord,
  outboxToRecord,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from "../infrastructure/persistence/mappers";
import { WalletLedgerEntryRecord, WalletRecord } from "../infrastructure/persistence/records";
import { inTransaction } from "../infrastructure/persistence/transaction";
import { uuidSchema } from "./contracts";

export const MAX_LEDGER_PAGE = 200;

@Injectable()
export class WalletService {
  constructor(private readonly orm: MikroORM) {}

  async create(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string) {
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();
    const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: input.playerId, initialBalance, at: now });
    try {
      await inTransaction(this.orm, async (em) => {
        em.persist(walletToRecord(wallet));
        await em.flush();
        if (initialBalance.isZero()) return;
        // OPENING + CREDIT no ledger na mesma transação SQL da wallet.
        const opening = WagerTransaction.createOpening({
          id: Bun.randomUUIDv7(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          createdAt: now,
        });
        const entry = wallet.openingLedger(opening.id, Bun.randomUUIDv7(), now)!;
        opening.markProcessed(undefined, now, wallet.balance);
        em.persist(transactionToRecord(opening));
        await em.flush();
        em.persist(ledgerToRecord(entry));
        const ctx = () => ({ eventId: Bun.randomUUIDv7(), correlationId, occurredAt: now });
        em.persist(outboxToRecord(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx()))));
        em.persist(outboxToRecord(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx()))));
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) throw new DuplicateWalletError();
      throw error;
    }
    log("info", "wallet created", { correlationId, walletId: wallet.id });
    return walletView(wallet);
  }

  async get(walletId: string) {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) throw new WalletNotFoundError();
    return walletView(walletToDomain(record));
  }

  /** Cursor opaco = base64url do último id (UUIDv7, ordenável). Estável sob inserções novas. */
  async ledger(walletId: string, cursor: string | undefined, limit: number) {
    await this.get(walletId);
    const after = cursor ? decodeCursor(cursor) : undefined;
    const records = await this.orm.em.fork().find(
      WalletLedgerEntryRecord,
      { walletId, ...(after ? { id: { $gt: after } } : {}) },
      { orderBy: { id: "asc" }, limit: limit + 1 },
    );
    const page = records.slice(0, limit);
    return {
      items: page.map((record) => {
        const entry = ledgerToDomain(record);
        return {
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt,
        };
      }),
      nextCursor: records.length > limit ? Buffer.from(page.at(-1)!.id).toString("base64url") : null,
    };
  }

  /** Uma única query = um único snapshot: saldo materializado e soma do ledger vistos no mesmo instante. */
  async reconcile(walletId: string) {
    const [row] = await this.orm.em.getConnection().execute<
      { stored: string; calculated: string; difference: string; currency: string; entries: number }[]
    >(
      `select w.currency,
              w.balance_amount::text as stored,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19, 2)::text as calculated,
              (w.balance_amount - coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0))::numeric(19, 2)::text as difference,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) throw new WalletNotFoundError();
    const consistent = row.difference === "0.00";
    if (!consistent) {
      // Divergência nunca é corrigida aqui: log + métrica + resposta sinalizada.
      metrics.reconciliationDivergences.inc();
      log("error", "wallet balance diverges from ledger", { walletId });
    }
    const money = (amount: string) => ({ amount, currency: row.currency });
    return {
      walletId,
      storedBalance: money(row.stored),
      calculatedBalance: money(row.calculated),
      difference: money(row.difference),
      consistent,
      checkedEntries: row.entries,
    };
  }
}

function decodeCursor(cursor: string): string {
  const parsed = uuidSchema.safeParse(Buffer.from(cursor, "base64url").toString());
  if (!parsed.success) throw new ValidationError("invalid cursor");
  return parsed.data;
}

function walletView(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}
