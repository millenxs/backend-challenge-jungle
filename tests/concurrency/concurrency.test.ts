import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { queues } from "../../src/infrastructure/messaging/sqs";
import {
  balanceOf,
  createWallet,
  drain,
  expectLedgerMatchesBalance,
  ledgerCount,
  openDb,
  queueDepth,
  sendMessage,
  startInstance,
  stopInstance,
  submit,
  waitFor,
  wager,
  wagerMessage,
  type Instance,
} from "../support";

/** Três processos reais da aplicação, mesmo PostgreSQL e mesma fila SQS. */
let orm: MikroORM;
let instances: Instance[] = [];
const pick = (i: number) => instances[i % instances.length]!.url;

beforeAll(async () => {
  orm = await openDb();
  await drain(queues.wager);
  instances = await Promise.all([3201, 3202, 3203].map((port) => startInstance(port)));
});
afterAll(async () => {
  await Promise.all(instances.map(stopInstance));
  await orm.close(true);
});

describe("concurrency with 3 instances", () => {
  test("the same bet sent 50 times in parallel debits exactly once", async () => {
    const wallet = await createWallet(pick(0));
    const bet = wager(wallet, "BET", "10.00");
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(pick(i), bet)));

    expect(responses.every((r) => r.status === 200 && r.body.status === "PROCESSED")).toBe(true);
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === "90.00")).toBe(true);
    expect(await ledgerCount(orm, wallet.id)).toBe(2);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("mandatory scenario: 100.00 balance, two concurrent 80.00 bets", async () => {
    const wallet = await createWallet(pick(0), "100.00");
    const bets = [wager(wallet, "BET", "80.00"), wager(wallet, "BET", "80.00")];
    const responses = await Promise.all([submit(pick(1), bets[0]!), submit(pick(2), bets[1]!)]);

    expect(responses.map((r) => r.body.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = responses.find((r) => r.body.status === "REJECTED")!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(orm, wallet.id)).toBe("20.00");
    expect(await ledgerCount(orm, wallet.id)).toBe(2); // OPENING + exatamente um DEBIT

    // Retries de ambos não mudam nada: devolvem o resultado original.
    const retries = await Promise.all(bets.map((bet, i) => submit(pick(i), bet)));
    expect(retries.map((r) => [r.body.status, r.body.idempotentReplay])).toEqual(responses.map((r) => [r.body.status, true]));
    expect(await ledgerCount(orm, wallet.id)).toBe(2);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("hot wallet: 60 distinct bets across instances never overdraw", async () => {
    const wallet = await createWallet(pick(0), "30.00");
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => submit(pick(i), wager(wallet, "BET", "1.00"))),
    );
    expect(responses.filter((r) => r.body.status === "PROCESSED")).toHaveLength(30);
    expect(responses.filter((r) => r.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(30);
    expect(await balanceOf(orm, wallet.id)).toBe("0.00");
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("different wallets are processed in parallel and stay independent", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => createWallet(pick(i), "50.00")));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((wallet, w) => Array.from({ length: 10 }, (_, i) => submit(pick(w + i), wager(wallet, "BET", "2.50")))),
    );
    const elapsed = performance.now() - started;
    for (const wallet of wallets) expect(await balanceOf(orm, wallet.id)).toBe("25.00");
    await expectLedgerMatchesBalance(orm, wallets.map((w) => w.id));
    expect(elapsed).toBeLessThan(30_000);
  });

  test("HTTP and SQS hitting the same wallet across instances converge to a consistent balance", async () => {
    const wallet = await createWallet(pick(0), "100.00");
    const viaHttp = Array.from({ length: 20 }, () => wager(wallet, "BET", "1.00"));
    const viaSqs = Array.from({ length: 20 }, () => wager(wallet, "BET", "1.00"));
    await Promise.all([
      ...viaSqs.map((body) => sendMessage(wagerMessage(body), wallet.id)),
      ...viaHttp.map((body, i) => submit(pick(i), body)),
    ]);
    await waitFor(async () => (await queueDepth(queues.wager)) === 0 && (await balanceOf(orm, wallet.id)) === "60.00", 60_000);
    expect(await ledgerCount(orm, wallet.id)).toBe(41);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });
});

describe("out-of-order references", () => {
  test("REFUND delivered before its BET waits as PENDING_REFERENCE and is applied once the BET arrives", async () => {
    const wallet = await createWallet(pick(0), "100.00");
    const bet = wager(wallet, "BET", "40.00");
    const refund = wager(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId });

    const early = await submit(pick(1), refund);
    expect(early.status).toBe(202);
    expect(early.body.status).toBe("PENDING_REFERENCE");
    expect((await submit(pick(2), bet)).body.balance.amount).toBe("60.00");

    const applied = await waitFor(async () => {
      const replay = await submit(pick(0), refund);
      return replay.body.status === "PROCESSED" && replay;
    }, 30_000);
    expect(applied.body).toMatchObject({ idempotentReplay: true, balance: { amount: "100.00" } });
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });

  test("ROLLBACK of a WIN delivered before the WIN is applied after the WIN", async () => {
    const wallet = await createWallet(pick(0), "10.00");
    const win = wager(wallet, "WIN", "50.00");
    const rollback = wager(wallet, "ROLLBACK", "50.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect((await submit(pick(0), rollback)).status).toBe(202);
    await submit(pick(1), win);
    await waitFor(async () => (await balanceOf(orm, wallet.id)) === "10.00" && (await ledgerCount(orm, wallet.id)) === 3, 30_000);
    await expectLedgerMatchesBalance(orm, [wallet.id]);
  });
});
