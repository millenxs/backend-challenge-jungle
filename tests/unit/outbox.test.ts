import { describe, expect, test } from "bun:test";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransactionProcessed } from "../../src/domain/events/wagering-events";
import { WagerTransactionKind } from "../../src/domain/enums";
import { WagerTransaction } from "../../src/domain/wager-transaction";
import { Money } from "../../src/domain/money";

describe("OutboxMessage", () => {
  test("schedules exponential backoff and can be marked published", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "p",
      externalTransactionId: "e",
      idempotencyKey: "p:e",
      payloadHash: "h",
      walletId: "w-1",
      playerId: "pl",
      roundId: "r",
      gameId: "g",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "1.00", currency: "BRL" }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    tx.markProcessed(undefined, new Date("2026-01-01T00:00:00.000Z"));
    const event = WagerTransactionProcessed.from(tx, {
      eventId: "evt-1",
      correlationId: "c-1",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    const now = new Date("2026-01-01T00:00:01.000Z");
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    outbox.markPublished(now);
    expect(outbox.isPending()).toBe(false);
  });
});
