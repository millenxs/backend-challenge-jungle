import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletService } from "../../src/application/wallet.service";
import { queues } from "../../src/infrastructure/messaging/sqs";
import {
  balanceOf,
  drain,
  expectLedgerMatchesBalance,
  ledgerCount,
  openDb,
  queueDepth,
  sendMessage,
  sql,
  startInstance,
  stopInstance,
  submit,
  uuid,
  waitFor,
  wager,
  wagerMessage,
  type Instance,
} from "../support";

let orm: MikroORM;
let running: Instance[] = [];
const start = async (port: number, env: Record<string, string> = {}) => {
  const instance = await startInstance(port, env);
  running.push(instance);
  return instance;
};

beforeAll(async () => {
  orm = await openDb();
  await drain(queues.wager);
});
afterEach(async () => {
  await Promise.all(running.map(stopInstance));
  running = [];
});
afterAll(() => orm.close(true));

const newWallet = async (amount = "100.00") => {
  const playerId = uuid();
  const created = await new WalletService(orm).create({ playerId, initialBalance: { amount, currency: "BRL" } }, "test");
  return { id: created.id, playerId };
};

describe("crash recovery", () => {
  test("worker killed after commit and before ack: redelivery is absorbed by the inbox", async () => {
    const wallet = await newWallet();
    const message = wagerMessage(wager(wallet, "BET", "30.00"));

    // Instância A comita e morre antes do DeleteMessage.
    const crashing = await start(3301, { FAULT_INJECT: "after-commit", SQS_VISIBILITY_TIMEOUT: "3" });
    await sendMessage(message, wallet.id);
    expect(await crashing.proc.exited).toBe(1);
    expect(await balanceOf(orm, wallet.id)).toBe("70.00"); // commit aconteceu
    expect(await queueDepth(queues.wager)).toBe(1); // mas a mensagem não foi confirmada

    // Instância B recebe a mesma mensagem após o visibility timeout.
    await start(3302, { SQS_VISIBILITY_TIMEOUT: "3" });
    await waitFor(async () => (await queueDepth(queues.wager)) === 0, 30_000);

    expect(await balanceOf(orm, wallet.id)).toBe("70.00");
    expect(await ledgerCount(orm, wallet.id)).toBe(2);
    const [inbox] = await sql<{ n: number }>(orm, "select count(*)::int as n from inbox_messages where message_id = ?", [message.messageId]);
    expect(inbox!.n).toBe(1);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("service killed mid-load and restarted: resending everything converges with no duplicates", async () => {
    const wallet = await newWallet("100.00");
    const bets = Array.from({ length: 40 }, () => wager(wallet, "BET", "1.00"));
    const first = await start(3303);
    // Dispara a carga e mata o processo no meio, sem esperar as respostas.
    const inFlight = bets.map((bet) => submit(first.url, bet).catch(() => undefined));
    await Bun.sleep(150);
    await stopInstance(first);
    await Promise.all(inFlight);

    const second = await start(3304);
    const results = await Promise.all(bets.map((bet) => submit(second.url, bet)));
    expect(results.every((r) => r.status === 200 && r.body.status === "PROCESSED")).toBe(true);

    const [counts] = await sql<{ transactions: number; distinct_external: number }>(
      orm,
      `select count(*)::int as transactions, count(distinct external_transaction_id)::int as distinct_external
         from wager_transactions where wallet_id = ? and kind = 'BET'`,
      [wallet.id],
    );
    expect(counts).toEqual({ transactions: 40, distinct_external: 40 });
    expect(await balanceOf(orm, wallet.id)).toBe("60.00");
    expect(await ledgerCount(orm, wallet.id)).toBe(41);
    const reconciliation = await (await fetch(`${second.url}/wallets/${wallet.id}/reconciliation`, { method: "POST" })).json();
    expect(reconciliation).toMatchObject({ consistent: true, checkedEntries: 41, difference: { amount: "0.00" } });
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  // Windows não entrega SIGTERM a processos (TerminateProcess é imediato): só verificável em POSIX/CI.
  test.skipIf(process.platform === "win32")("SIGTERM drains in-flight messages and exits cleanly", async () => {
    const wallet = await newWallet("100.00");
    const instance = await start(3305);
    const messages = Array.from({ length: 10 }, () => wagerMessage(wager(wallet, "BET", "1.00")));
    await Promise.all(messages.map((message) => sendMessage(message, wallet.id)));
    await waitFor(async () => (await ledgerCount(orm, wallet.id)) > 1, 15_000);
    instance.proc.kill("SIGTERM");
    expect(await instance.proc.exited).toBe(0);

    await start(3306); // o que sobrou na fila é processado por outra instância, sem duplicar
    await waitFor(async () => (await queueDepth(queues.wager)) === 0 && (await ledgerCount(orm, wallet.id)) === 11, 30_000);
    expect(await balanceOf(orm, wallet.id)).toBe("90.00");
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });
});
