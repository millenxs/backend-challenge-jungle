import { Money } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { WagerTransaction } from "../../domain/wager-transaction";
import {
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./records";

export function walletToRecord(wallet: Wallet): WalletRecord {
  const record = new WalletRecord();
  const snap = wallet.snapshot();
  record.id = snap.id;
  record.playerId = snap.playerId;
  record.currency = snap.currency;
  record.balanceAmount = snap.balance.amount;
  record.version = snap.version;
  record.createdAt = snap.createdAt;
  record.updatedAt = snap.updatedAt;
  return record;
}

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: { amount: record.balanceAmount, currency: record.currency },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function applyWalletToRecord(wallet: Wallet, record: WalletRecord): void {
  const snap = wallet.snapshot();
  record.balanceAmount = snap.balance.amount;
  record.version = snap.version;
  record.updatedAt = snap.updatedAt;
}

export function transactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  const record = new WagerTransactionRecord();
  applyTransactionToRecord(tx, record);
  return record;
}

export function applyTransactionToRecord(tx: WagerTransaction, record: WagerTransactionRecord): void {
  const snap = tx.snapshot();
  record.id = snap.id;
  record.providerId = snap.providerId;
  record.externalTransactionId = snap.externalTransactionId;
  record.idempotencyKey = snap.idempotencyKey;
  record.payloadHash = snap.payloadHash;
  record.walletId = snap.walletId;
  record.playerId = snap.playerId;
  record.roundId = snap.roundId;
  record.gameId = snap.gameId;
  record.kind = snap.kind;
  record.amount = snap.money.toJSON().amount;
  record.currency = snap.money.currency;
  record.referenceExternalTransactionId = snap.referenceExternalTransactionId;
  record.createdAt = snap.createdAt;
  record.status = snap.status;
  record.referenceTransactionId = snap.referenceTransactionId;
  record.failureCode = snap.failureCode;
  record.processedAt = snap.processedAt;
  record.retryAttempts = snap.retryAttempts;
  record.nextAttemptAt = snap.nextAttemptAt;
  record.balanceAfterAmount = snap.balanceAfter?.toJSON().amount;
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    createdAt: record.createdAt,
    status: record.status,
    referenceTransactionId: record.referenceTransactionId,
    failureCode: record.failureCode,
    processedAt: record.processedAt,
    retryAttempts: record.retryAttempts,
    nextAttemptAt: record.nextAttemptAt,
    balanceAfter: record.balanceAfterAmount ? Money.from({ amount: record.balanceAfterAmount, currency: record.currency }) : undefined,
  });
}

export function ledgerToRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
  const record = new WalletLedgerEntryRecord();
  record.id = entry.id;
  record.walletId = entry.walletId;
  record.transactionId = entry.transactionId;
  record.direction = entry.direction;
  record.amount = entry.money.toJSON().amount;
  record.currency = entry.money.currency;
  record.balanceBeforeAmount = entry.balanceBefore.toJSON().amount;
  record.balanceAfterAmount = entry.balanceAfter.toJSON().amount;
  record.createdAt = entry.createdAt;
  return record;
}

export function ledgerToDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    balanceBefore: Money.from({ amount: record.balanceBeforeAmount, currency: record.currency }),
    balanceAfter: Money.from({ amount: record.balanceAfterAmount, currency: record.currency }),
    createdAt: record.createdAt,
  });
}

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  const record = new OutboxMessageRecord();
  record.id = message.id;
  record.aggregateId = message.aggregateId;
  record.eventType = message.eventType;
  record.payload = { ...message.payload };
  record.occurredAt = message.occurredAt;
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt;
  record.publishedAt = message.publishedAt;
  return record;
}

export function applyOutboxToRecord(message: OutboxMessage, record: OutboxMessageRecord): void {
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt;
  record.publishedAt = message.publishedAt;
}

export function outboxToDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: record.publishedAt,
  });
}
