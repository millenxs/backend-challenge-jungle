import { Entity, PrimaryKey, Property, Enum } from "@mikro-orm/core";
import { DecimalType } from "@mikro-orm/core";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/enums";

@Entity({ tableName: "wallets" })
export class WalletRecord {
  @PrimaryKey()
  id!: string;

  @Property()
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 19, scale: 2 })
  balanceAmount!: string;

  @Property()
  version!: number;

  @Property()
  createdAt!: Date;

  @Property()
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transactions" })
export class WagerTransactionRecord {
  @PrimaryKey()
  id!: string;

  @Property()
  providerId!: string;

  @Property()
  externalTransactionId!: string;

  @Property()
  idempotencyKey!: string;

  @Property()
  payloadHash!: string;

  @Property()
  walletId!: string;

  @Property()
  playerId!: string;

  @Property()
  roundId!: string;

  @Property()
  gameId!: string;

  @Enum(() => WagerTransactionKind)
  kind!: WagerTransactionKind;

  @Property({ type: DecimalType, precision: 19, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ nullable: true })
  referenceExternalTransactionId?: string;

  @Property()
  createdAt!: Date;

  @Enum(() => WagerTransactionStatus)
  status!: WagerTransactionStatus;

  @Property({ nullable: true })
  referenceTransactionId?: string;

  @Enum({ items: () => FailureCode, nullable: true })
  failureCode?: FailureCode;

  @Property({ nullable: true })
  processedAt?: Date;

  @Property()
  retryAttempts!: number;

  @Property({ nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: DecimalType, precision: 19, scale: 2, nullable: true })
  balanceAfterAmount?: string;
}

@Entity({ tableName: "wallet_ledger_entries" })
export class WalletLedgerEntryRecord {
  @PrimaryKey()
  id!: string;

  @Property()
  walletId!: string;

  @Property()
  transactionId!: string;

  @Enum(() => LedgerDirection)
  direction!: LedgerDirection;

  @Property({ type: DecimalType, precision: 19, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: DecimalType, precision: 19, scale: 2 })
  balanceBeforeAmount!: string;

  @Property({ type: DecimalType, precision: 19, scale: 2 })
  balanceAfterAmount!: string;

  @Property()
  createdAt!: Date;
}

@Entity({ tableName: "inbox_messages" })
export class InboxMessageRecord {
  @PrimaryKey({ name: "consumer_name" })
  consumerName!: string;

  @PrimaryKey({ name: "message_id" })
  messageId!: string;

  @Property()
  payloadHash!: string;

  @Property()
  receivedAt!: Date;

  @Property({ nullable: true })
  processedAt?: Date;
}

@Entity({ tableName: "outbox_messages" })
export class OutboxMessageRecord {
  @PrimaryKey()
  id!: string;

  @Property()
  aggregateId!: string;

  @Property()
  eventType!: string;

  @Property({ type: "json" })
  payload!: Record<string, unknown>;

  @Property()
  occurredAt!: Date;

  @Property()
  attempts!: number;

  @Property({ nullable: true })
  nextAttemptAt?: Date;

  @Property({ nullable: true })
  publishedAt?: Date;
}
