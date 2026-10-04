import { expect } from "bun:test";
import type { Subprocess } from "bun";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";
import { queues, sqs } from "../src/infrastructure/messaging/sqs";

/** Requer `docker compose up -d` (PostgreSQL + LocalStack reais). Cada teste usa ids próprios: sem limpeza de tabelas. */
export async function openDb(): Promise<MikroORM> {
  const orm = await MikroORM.init(createMikroOrmConfig());
  await orm.getMigrator().up();
  return orm;
}

export function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.getConnection().execute(query, params) as Promise<T[]>;
}

export const uuid = () => crypto.randomUUID();

/** ponytail: `expect(p).rejects.toThrow()` do Bun 1.3 trava com erros do driver pg; captura e compara a mensagem. */
export async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!error) throw new Error("expected promise to reject");
  return error instanceof Error ? error.message : String(error);
}

// ---- instâncias reais da aplicação (processos separados) ----

export interface Instance {
  url: string;
  proc: Subprocess;
}

export async function startInstance(port: number, env: Record<string, string> = {}): Promise<Instance> {
  const proc = Bun.spawn([process.execPath, "src/main.ts"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://localhost:${port}`;
  // Boot pode passar de 20s no WSL lendo /mnt/c; 60s de folga.
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) throw new Error(`instance on ${port} exited with ${proc.exitCode}`);
    try {
      if ((await fetch(`${url}/health/live`)).ok) return { url, proc };
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  throw new Error(`instance on ${port} did not start`);
}

export async function stopInstance(instance: Instance | undefined): Promise<void> {
  if (!instance || instance.proc.exitCode !== null) return;
  instance.proc.kill("SIGKILL");
  await instance.proc.exited;
}

// ---- API ----

export async function createWallet(url: string, amount = "100.00"): Promise<{ id: string; playerId: string }> {
  const playerId = uuid();
  const response = await fetch(`${url}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: "BRL" } }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

export function wager(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${uuid()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

export type Wager = ReturnType<typeof wager>;

export async function submit(url: string, body: Wager): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${url}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

// ---- SQS ----

export function wagerMessage(body: Wager, messageId = `msg-${uuid()}`) {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
  };
}

/** DeduplicationId aleatório: simula o broker entregando duplicado mesmo com FIFO (não confiamos nele). */
export function sendMessage(message: object | string, groupId = "test", queueUrl = queues.wager) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof message === "string" ? message : JSON.stringify(message),
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

/** Esvazia uma fila (PurgeQueue tem janela de 60s na AWS; drenar é determinístico). */
export async function drain(queueUrl: string): Promise<string[]> {
  const bodies: string[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    if (Messages.length === 0) return bodies;
    for (const message of Messages) {
      bodies.push(message.Body ?? "");
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

export async function queueDepth(queueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages ?? 0) + Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
}

// ---- espera e invariantes ----

export async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(200);
  }
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectLedgerMatchesBalance(orm: MikroORM, walletIds: string[]): Promise<void> {
  const rows = await sql<{ id: string; stored: string; calculated: string }>(
    orm,
    `select w.id,
            w.balance_amount::text as stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19, 2)::text as calculated
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id in (${walletIds.map(() => "?").join(", ")})
      group by w.id`,
    walletIds,
  );
  expect(rows.length).toBe(walletIds.length);
  for (const row of rows) {
    expect({ wallet: row.id, balance: row.stored }).toEqual({ wallet: row.id, balance: row.calculated });
  }
}

export async function balanceOf(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>(orm, "select balance_amount::text as balance from wallets where id = ?", [walletId]);
  return row!.balance;
}

export async function ledgerCount(orm: MikroORM, walletId: string): Promise<number> {
  const [row] = await sql<{ n: number }>(orm, "select count(*)::int as n from wallet_ledger_entries where wallet_id = ?", [walletId]);
  return row!.n;
}
