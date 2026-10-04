import { Injectable } from "@nestjs/common";
import { LockMode, MikroORM, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { applyWagering } from "../domain/apply-wagering";
import { WagerTransactionKind, WagerTransactionStatus } from "../domain/enums";
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  ValidationError,
  WalletNotFoundError,
} from "../domain/errors";
import type { IntegrationEvent } from "../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../domain/events/wagering-events";
import { Money } from "../domain/money";
import { OutboxMessage } from "../domain/outbox-message";
import { businessPayload, payloadHashOf } from "../domain/payload-hash";
import { WagerTransaction } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import { log, metrics } from "../infrastructure/observability";
import {
  applyTransactionToRecord,
  applyWalletToRecord,
  ledgerToRecord,
  outboxToRecord,
  transactionToDomain,
  walletToDomain,
} from "../infrastructure/persistence/mappers";
import { WagerTransactionRecord, WalletRecord } from "../infrastructure/persistence/records";
import { inTransaction } from "../infrastructure/persistence/transaction";
import type { WagerRequest, WagerResult } from "./contracts";

export interface SubmitContext {
  correlationId: string;
  source: "http" | "sqs";
  /** Presente quando a entrada é SQS: dedup persistente por (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

@Injectable()
export class WageringService {
  constructor(private readonly orm: MikroORM) {}

  /** Use case único para HTTP e SQS. */
  async submit(idempotencyKey: string, request: WagerRequest, ctx: SubmitContext): Promise<WagerResult> {
    const money = Money.from(request.money);
    if (!money.isPositive()) {
      throw new ValidationError("money.amount must be greater than zero");
    }
    const payloadHash = payloadHashOf(businessPayload(request));
    const timer = metrics.processing.startTimer({ source: ctx.source });
    try {
      const result = await this.submitOnce(idempotencyKey, request, money, payloadHash, ctx).catch((error) => {
        // Corrida entre wallets diferentes com a mesma key/externalId: o unique do banco barra,
        // e a segunda tentativa cai no caminho de replay/conflito.
        if (!(error instanceof UniqueConstraintViolationException)) throw error;
        metrics.retries.inc({ reason: "unique_violation" });
        return this.submitOnce(idempotencyKey, request, money, payloadHash, ctx);
      });
      if (result.idempotentReplay) {
        metrics.duplicates.inc({ source: ctx.inbox ? "inbox_or_key" : "idempotency_key" });
      } else {
        metrics.transactions.inc({ status: result.status, source: ctx.source });
      }
      log("info", "wager transaction handled", {
        correlationId: ctx.correlationId,
        messageId: ctx.inbox?.messageId,
        transactionId: result.transactionId,
        walletId: request.walletId,
        providerId: request.providerId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } finally {
      timer();
    }
  }

  /** Chamado pelo worker agendado para transações PENDING_REFERENCE vencidas. */
  async retryPending(transactionId: string): Promise<void> {
    const status = await inTransaction(this.orm, async (em) => {
      const head = await em.findOne(WagerTransactionRecord, { id: transactionId });
      if (!head) return undefined;
      const walletRecord = await em.findOneOrFail(
        WalletRecord,
        { id: head.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      // Relê depois do lock: outra instância pode ter processado enquanto esperávamos.
      const record = await em.findOneOrFail(WagerTransactionRecord, { id: transactionId }, { refresh: true });
      if (record.status !== WagerTransactionStatus.PendingReference) return undefined;
      if (record.nextAttemptAt && record.nextAttemptAt > new Date()) return undefined;
      const tx = transactionToDomain(record);
      await this.applyAndPersist(em, walletRecord, walletToDomain(walletRecord), tx, record, {
        correlationId: `pending-retry:${transactionId}`,
      });
      return tx.status;
    });
    if (status) {
      metrics.retries.inc({ reason: "pending_reference" });
      if (status !== WagerTransactionStatus.PendingReference) {
        metrics.transactions.inc({ status, source: "pending_worker" });
      }
      log("info", "pending reference retried", { transactionId, status });
    }
  }

  async findDuePending(limit: number): Promise<string[]> {
    const rows = await this.orm.em.fork().find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: new Date() } },
      { fields: ["id"], orderBy: { nextAttemptAt: "asc" }, limit },
    );
    return rows.map((row) => row.id);
  }

  async getById(transactionId: string) {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { id: transactionId });
    if (!record) throw new TransactionNotFoundError();
    return transactionView(record);
  }

  async getByExternalId(providerId: string, externalTransactionId: string) {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    if (!record) throw new TransactionNotFoundError();
    return transactionView(record);
  }

  private submitOnce(
    idempotencyKey: string,
    request: WagerRequest,
    money: Money,
    payloadHash: string,
    ctx: SubmitContext,
  ): Promise<WagerResult> {
    return inTransaction(this.orm, async (em) => {
      // 1. Lock por wallet: serializa tudo que toca esta wallet, em qualquer instância.
      const walletRecord = await em.findOne(
        WalletRecord,
        { id: request.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!walletRecord) throw new WalletNotFoundError();

      // 2. Inbox na mesma transação: só existe se o efeito financeiro também for confirmado.
      if (ctx.inbox && !(await claimInbox(em, ctx.inbox))) {
        const existing = await em.findOne(WagerTransactionRecord, { idempotencyKey });
        if (!existing || existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
        return toResult(existing, true);
      }

      // 3. Idempotência persistente. Lida depois do lock, então enxerga o commit concorrente.
      const existing = await em.findOne(WagerTransactionRecord, { idempotencyKey });
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new IdempotencyConflictError();
        return toResult(existing, true);
      }
      const sameExternalId = await em.count(WagerTransactionRecord, {
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
      });
      if (sameExternalId > 0) throw new IdempotencyConflictError();

      // 4. Regras de negócio e persistência atômica.
      const tx = WagerTransaction.create({
        id: Bun.randomUUIDv7(),
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: request.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: request.referenceExternalTransactionId,
        createdAt: new Date(),
      });
      const record = await this.applyAndPersist(em, walletRecord, walletToDomain(walletRecord), tx, undefined, {
        correlationId: ctx.correlationId,
        causationId: ctx.inbox?.messageId,
      });
      return toResult(record, false);
    });
  }

  private async applyAndPersist(
    em: EntityManager,
    walletRecord: WalletRecord,
    wallet: Wallet,
    tx: WagerTransaction,
    existingRecord: WagerTransactionRecord | undefined,
    eventCtx: { correlationId: string; causationId?: string },
  ): Promise<WagerTransactionRecord> {
    const now = new Date();
    const reference = tx.referenceExternalTransactionId
      ? await em.findOne(WagerTransactionRecord, {
          providerId: tx.providerId,
          externalTransactionId: tx.referenceExternalTransactionId,
        })
      : null;
    const reversals = reference
      ? await em.find(WagerTransactionRecord, {
          referenceTransactionId: reference.id,
          status: WagerTransactionStatus.Processed,
          kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        })
      : [];
    const wasPending = tx.status === WagerTransactionStatus.PendingReference;

    const outcome = applyWagering({
      wallet,
      transaction: tx,
      reference: reference ? transactionToDomain(reference) : undefined,
      alreadyRefunded: reversals.some((r) => r.kind === WagerTransactionKind.Refund),
      alreadyRolledBack: reversals.some((r) => r.kind === WagerTransactionKind.Rollback),
      now,
      ledgerId: Bun.randomUUIDv7(),
    });

    const record = existingRecord ?? new WagerTransactionRecord();
    applyTransactionToRecord(tx, record);
    em.persist(record);
    await em.flush(); // a transação precisa existir antes do ledger (FK)

    const ctx = (): EventContext => ({ eventId: Bun.randomUUIDv7(), occurredAt: now, ...eventCtx });
    const events: IntegrationEvent<unknown>[] = [];
    if (outcome.outcome === "processed") {
      events.push(WagerTransactionProcessed.from(tx, ctx()));
      if (outcome.ledger) {
        applyWalletToRecord(wallet, walletRecord);
        em.persist(ledgerToRecord(outcome.ledger));
        events.push(WalletBalanceChanged.from(wallet, outcome.ledger, ctx()));
      }
    } else if (outcome.outcome === "rejected") {
      events.push(WagerTransactionRejected.from(tx, ctx()));
    } else if (!wasPending) {
      events.push(WagerTransactionPendingReference.from(tx, ctx()));
    }
    for (const event of events) {
      em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    }
    await em.flush();
    if (process.env.FAULT_INJECT === "before-commit") {
      // gancho de teste de atomicidade; nunca habilitado fora dos testes
      throw new Error("fault injected before commit");
    }
    return record;
  }
}

async function claimInbox(
  em: EntityManager,
  inbox: { consumerName: string; messageId: string; payloadHash: string },
): Promise<boolean> {
  // ON CONFLICT em vez de capturar a violação: um erro abortaria a transação inteira.
  const result = await em.execute<{ affectedRows: number }>(
    `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
     values (?, ?, ?, now(), now()) on conflict do nothing`,
    [inbox.consumerName, inbox.messageId, inbox.payloadHash],
    "run",
  );
  return result.affectedRows === 1;
}

function balanceOf(record: WagerTransactionRecord) {
  return record.balanceAfterAmount ? { amount: record.balanceAfterAmount, currency: record.currency } : null;
}

function toResult(record: WagerTransactionRecord, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: record.id,
    status: record.status,
    balance: balanceOf(record),
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    idempotentReplay,
  };
}

function transactionView(record: WagerTransactionRecord) {
  return {
    transactionId: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: { amount: record.amount, currency: record.currency },
    status: record.status,
    failureCode: record.failureCode ?? null,
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? null,
    referenceTransactionId: record.referenceTransactionId ?? null,
    balance: balanceOf(record),
    createdAt: record.createdAt,
    processedAt: record.processedAt ?? null,
  };
}
