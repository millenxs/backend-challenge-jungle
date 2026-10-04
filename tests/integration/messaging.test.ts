import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WageringService } from "../../src/application/wagering.service";
import { WalletService } from "../../src/application/wallet.service";
import { TransientInfrastructureError } from "../../src/domain/errors";
import { WagerTransactionProcessed } from "../../src/domain/events/wagering-events";
import { Money } from "../../src/domain/money";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { WagerTransaction } from "../../src/domain/wager-transaction";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { queues, sqs } from "../../src/infrastructure/messaging/sqs";
import { WagerConsumer, defaultConsumerOptions } from "../../src/infrastructure/messaging/wager-consumer";
import { outboxToRecord } from "../../src/infrastructure/persistence/mappers";
import { sqsHandler } from "../../src/infrastructure/workers";
import {
  balanceOf,
  drain,
  expectLedgerMatchesBalance,
  ledgerCount,
  openDb,
  queueDepth,
  sendMessage,
  sql,
  uuid,
  wager,
  wagerMessage,
} from "../support";

let orm: MikroORM;
let wallets: WalletService;
let wagering: WageringService;

beforeAll(async () => {
  orm = await openDb();
  wallets = new WalletService(orm);
  wagering = new WageringService(orm);
  await Promise.all([drain(queues.wager), drain(queues.dlq)]);
});
afterAll(async () => {
  await Promise.all([drain(queues.wager), drain(queues.dlq), drain(queues.events)]);
  await orm.close(true);
});

const newWallet = async (amount = "100.00") => {
  const playerId = uuid();
  const created = await wallets.create({ playerId, initialBalance: { amount, currency: "BRL" } }, "test");
  return { id: created.id, playerId };
};

const fastOptions = { ...defaultConsumerOptions(), waitTimeSeconds: 1, retryBaseSeconds: 0, visibilityTimeoutSeconds: 5 };

/** Faz polling até a fila esvaziar (inclusive mensagens em voo). */
async function consumeAll(consumer: WagerConsumer): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await consumer.poll();
    if ((await queueDepth(queues.wager)) === 0) return;
  }
  throw new Error("queue did not drain");
}

describe("inbox and redelivery", () => {
  test("the same message delivered three times is applied once and acked every time", async () => {
    const wallet = await newWallet();
    const message = wagerMessage(wager(wallet, "BET", "25.00"));
    // DeduplicationIds diferentes: o FIFO não barra — quem garante é a inbox no PostgreSQL.
    await sendMessage(message, wallet.id);
    await sendMessage(message, wallet.id);
    const consumer = new WagerConsumer(sqsHandler(wagering), fastOptions);
    await consumeAll(consumer);
    await sendMessage(message, wallet.id); // redelivery tardia, depois do commit
    await consumeAll(consumer);

    const [counts] = await sql<Record<string, number>>(
      orm,
      `select (select count(*)::int from wager_transactions where external_transaction_id = ?) as transactions,
              (select count(*)::int from inbox_messages where message_id = ?) as inbox`,
      [message.data.externalTransactionId, message.messageId],
    );
    expect(counts).toEqual({ transactions: 1, inbox: 1 });
    expect(await ledgerCount(orm, wallet.id)).toBe(2); // OPENING + BET
    expect(await balanceOf(orm, wallet.id)).toBe("75.00");
    expect(await queueDepth(queues.dlq)).toBe(0);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("HTTP and SQS share the use case: a message replaying an HTTP request is a replay, not a new debit", async () => {
    const wallet = await newWallet();
    const body = wager(wallet, "BET", "10.00");
    await wagering.submit(`${body.providerId}:${body.externalTransactionId}`, body as never, {
      correlationId: "http",
      source: "http",
    });
    await sendMessage(wagerMessage(body), wallet.id);
    await consumeAll(new WagerConsumer(sqsHandler(wagering), fastOptions));
    expect(await balanceOf(orm, wallet.id)).toBe("90.00");
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("business errors are acked, not retried", async () => {
    const ghost = { id: uuid(), playerId: uuid() }; // wallet inexistente
    await sendMessage(wagerMessage(wager(ghost, "BET", "1.00")), ghost.id);
    await consumeAll(new WagerConsumer(sqsHandler(wagering), fastOptions));
    expect(await queueDepth(queues.dlq)).toBe(0);
  });
});

describe("retry and DLQ", () => {
  test("transient failures are retried with backoff and dead-lettered after the attempt limit", async () => {
    await drain(queues.dlq);
    let calls = 0;
    const consumer = new WagerConsumer(async () => {
      calls++;
      throw new TransientInfrastructureError("database unavailable");
    }, { ...fastOptions, maxReceives: 3 });
    const message = wagerMessage(wager({ id: uuid(), playerId: uuid() }, "BET", "1.00"));
    await sendMessage(message, "retry");
    await consumeAll(consumer);
    expect(calls).toBe(3);
    const dead = await drain(queues.dlq);
    expect(dead.map((body) => JSON.parse(body).messageId)).toEqual([message.messageId]);
  });

  test("malformed messages are permanent errors and go straight to the DLQ", async () => {
    await drain(queues.dlq);
    let calls = 0;
    const consumer = new WagerConsumer(async () => void calls++, fastOptions);
    await sendMessage("{not json", "bad");
    await sendMessage({ messageId: "m", type: "WagerTransactionRequested", occurredAt: "x", data: { kind: "OPENING" } }, "bad");
    await consumeAll(consumer);
    expect(calls).toBe(0);
    expect(await drain(queues.dlq)).toHaveLength(2);
  });
});

describe("transactional outbox", () => {
  test("two concurrent publishers publish each committed event exactly once", async () => {
    // Eventos confirmados sem nenhum publisher rodando (equivale ao processo que morreu antes de publicar).
    const aggregateId = uuid();
    const ids: string[] = [];
    const em = orm.em.fork();
    for (let i = 0; i < 30; i++) {
      const tx = WagerTransaction.createOpening({
        id: uuid(),
        walletId: aggregateId,
        playerId: uuid(),
        money: Money.from({ amount: "1.00", currency: "BRL" }),
        createdAt: new Date(),
      });
      tx.markProcessed(undefined, new Date());
      const event = WagerTransactionProcessed.from(tx, { eventId: uuid(), correlationId: "t", occurredAt: new Date() });
      ids.push(event.eventId);
      em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    }
    await em.flush();

    // Espiona os envios reais ao SQS para contar publicações por eventId.
    const sent = new Map<string, number>();
    sqs.middlewareStack.add(
      (next) => async (args) => {
        const input = args.input as { QueueUrl?: string; MessageDeduplicationId?: string };
        if (input.QueueUrl === queues.events && input.MessageDeduplicationId) {
          sent.set(input.MessageDeduplicationId, (sent.get(input.MessageDeduplicationId) ?? 0) + 1);
        }
        return next(args);
      },
      { step: "initialize", name: "publishSpy" },
    );
    try {
      const pending = async () =>
        (await sql<{ n: number }>(orm, `select count(*)::int as n from outbox_messages where published_at is null and id in (${ids.map(() => "?").join(",")})`, ids))[0]!.n;
      const run = async (publisher: OutboxPublisher) => {
        while ((await pending()) > 0) await publisher.publishBatch();
      };
      await Promise.all([run(new OutboxPublisher(orm, 5)), run(new OutboxPublisher(orm, 5))]);
    } finally {
      sqs.middlewareStack.remove("publishSpy");
    }
    for (const id of ids) expect({ id, sends: sent.get(id) }).toEqual({ id, sends: 1 });

    // Envelope publicado é o JSON do IntegrationEvent.
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.events, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
    );
    expect(JSON.parse(Messages[0]!.Body!)).toMatchObject({ eventType: expect.any(String), version: 1, eventId: expect.any(String) });
  });

  test("a failed publication is retried with backoff instead of being lost", async () => {
    const aggregateId = uuid();
    const event = WagerTransactionProcessed.from(
      (() => {
        const tx = WagerTransaction.createOpening({
          id: uuid(),
          walletId: aggregateId,
          playerId: uuid(),
          money: Money.from({ amount: "1.00", currency: "BRL" }),
          createdAt: new Date(),
        });
        tx.markProcessed(undefined, new Date());
        return tx;
      })(),
      { eventId: uuid(), correlationId: "t", occurredAt: new Date() },
    );
    const em = orm.em.fork();
    em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    await em.flush();
    sqs.middlewareStack.add(
      (next) => async (args) => {
        if ((args.input as { MessageDeduplicationId?: string }).MessageDeduplicationId === event.eventId) {
          throw new Error("SQS unavailable");
        }
        return next(args);
      },
      { step: "initialize", name: "failPublish" },
    );
    try {
      while ((await sql<{ attempts: number }>(orm, "select attempts from outbox_messages where id = ?", [event.eventId]))[0]!.attempts === 0) {
        await new OutboxPublisher(orm, 200).publishBatch();
      }
    } finally {
      sqs.middlewareStack.remove("failPublish");
    }
    const [row] = await sql<{ attempts: number; published: boolean; delayed: boolean }>(
      orm,
      "select attempts, published_at is not null as published, next_attempt_at > now() as delayed from outbox_messages where id = ?",
      [event.eventId],
    );
    expect(row).toEqual({ attempts: 1, published: false, delayed: true });
  });
});

