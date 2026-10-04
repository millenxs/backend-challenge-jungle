import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { WagerTransaction } from "../../src/domain/wager-transaction";
import { applyWagering, PENDING_REFERENCE_MAX_ATTEMPTS } from "../../src/domain/apply-wagering";
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/enums";
import { InvalidTransactionStateError } from "../../src/domain/errors";
import { businessPayload, payloadHashOf } from "../../src/domain/payload-hash";

const at = new Date("2026-07-29T15:00:00.000Z");

function wallet(balance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    at,
  });
}

function tx(kind: WagerTransactionKind, amount: string, extra: Partial<{
  id: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
}> = {}): WagerTransaction {
  const money = Money.from({ amount, currency: "BRL" });
  const externalTransactionId = extra.externalTransactionId ?? `${kind}-1`;
  const payload = businessPayload({
    providerId: "provider-a",
    externalTransactionId,
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: extra.referenceExternalTransactionId,
  });
  return WagerTransaction.create({
    id: extra.id ?? `id-${externalTransactionId}`,
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: payloadHashOf(payload),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money,
    referenceExternalTransactionId: extra.referenceExternalTransactionId,
    createdAt: at,
  });
}

describe("wagering rules", () => {
  test("BET debits the wallet", () => {
    const w = wallet();
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    const result = applyWagering({
      wallet: w,
      transaction: bet,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result.outcome).toBe("processed");
    expect(w.balance.toJSON().amount).toBe("75.00");
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
  });

  test("BET with insufficient funds is rejected and does not move the balance", () => {
    const w = wallet("10.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    const result = applyWagering({
      wallet: w,
      transaction: bet,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.INSUFFICIENT_FUNDS });
    expect(w.balance.toJSON().amount).toBe("10.00");
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("WIN credits the wallet", () => {
    const w = wallet("75.00");
    const win = tx(WagerTransactionKind.Win, "50.00");
    applyWagering({
      wallet: w,
      transaction: win,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(w.balance.toJSON().amount).toBe("125.00");
  });

  test("LOSS does not move the balance or create a ledger entry", () => {
    const w = wallet("75.00");
    const loss = tx(WagerTransactionKind.Loss, "25.00");
    const result = applyWagering({
      wallet: w,
      transaction: loss,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result).toEqual({ outcome: "processed" });
    expect(w.balance.toJSON().amount).toBe("75.00");
    expect(w.version).toBe(1);
  });

  test("REFUND credits back a processed BET once", () => {
    const w = wallet();
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    applyWagering({
      wallet: w,
      transaction: bet,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    applyWagering({
      wallet: w,
      transaction: refund,
      reference: bet,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l2",
    });
    expect(w.balance.toJSON().amount).toBe("100.00");
  });

  test("second REFUND of the same BET is rejected", () => {
    const w = wallet("75.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    bet.markProcessed(undefined, at, w.balance);
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const result = applyWagering({
      wallet: w,
      transaction: refund,
      reference: bet,
      alreadyRefunded: true,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.REFERENCE_ALREADY_REVERSED });
  });

  test("ROLLBACK of a WIN debits the winnings", () => {
    const w = wallet("150.00");
    const win = tx(WagerTransactionKind.Win, "50.00");
    win.markProcessed(undefined, at, w.balance);
    const rollback = tx(WagerTransactionKind.Rollback, "50.00", {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    applyWagering({
      wallet: w,
      transaction: rollback,
      reference: win,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(w.balance.toJSON().amount).toBe("100.00");
  });

  test("ROLLBACK that would make the balance negative uses a distinct failure code", () => {
    const w = wallet("10.00");
    const win = tx(WagerTransactionKind.Win, "50.00");
    win.markProcessed(undefined, at, w.balance);
    const rollback = tx(WagerTransactionKind.Rollback, "50.00", {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const result = applyWagering({
      wallet: w,
      transaction: rollback,
      reference: win,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.REVERSAL_WOULD_MAKE_NEGATIVE });
  });

  test("REFUND without a reference stays pending", () => {
    const w = wallet();
    const refund = tx(WagerTransactionKind.Refund, "25.00", { referenceExternalTransactionId: "missing" });
    const result = applyWagering({
      wallet: w,
      transaction: refund,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result.outcome).toBe("pending_reference");
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test("currency mismatch is rejected", () => {
    const w = wallet();
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    const usdWallet = Wallet.open({
      id: "wallet-usd",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "USD" }),
      at,
    });
    const result = applyWagering({
      wallet: usdWallet,
      transaction: bet,
      alreadyRefunded: false,
      alreadyRolledBack: false,
      now: at,
      ledgerId: "l1",
    });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH });
  });

  test("terminal transactions cannot transition again", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, at, Money.from({ amount: "100.00", currency: "BRL" }));
    expect(() => bet.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
  });

  test("OPENING cannot be created through the public factory", () => {
    expect(() =>
      WagerTransaction.create({
        id: "x",
        providerId: "p",
        externalTransactionId: "e",
        idempotencyKey: "k",
        payloadHash: "h",
        walletId: "w",
        playerId: "pl",
        roundId: "r",
        gameId: "g",
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: "1.00", currency: "BRL" }),
        createdAt: at,
      }),
    ).toThrow();
  });

  test("same idempotency key with a different payload is a conflict", () => {
    const first = tx(WagerTransactionKind.Bet, "10.00");
    const secondPayload = payloadHashOf(
      businessPayload({
        providerId: "provider-a",
        externalTransactionId: "BET-1",
        playerId: "player-1",
        walletId: "wallet-1",
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: { amount: "20.00", currency: "BRL" },
      }),
    );
    expect(first.matchesPayload(secondPayload)).toBe(false);
  });

  test("WIN referencing a BET may carry a different amount", () => {
    const w = wallet("75.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    bet.markProcessed(undefined, at);
    const win = tx(WagerTransactionKind.Win, "60.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const result = applyWagering({ wallet: w, transaction: win, reference: bet, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    expect(result.outcome).toBe("processed");
    expect(w.balance.toJSON().amount).toBe("135.00");
  });

  test("REFUND must reference a BET", () => {
    const w = wallet();
    const win = tx(WagerTransactionKind.Win, "10.00");
    win.markProcessed(undefined, at);
    const refund = tx(WagerTransactionKind.Refund, "10.00", { referenceExternalTransactionId: win.externalTransactionId });
    const result = applyWagering({ wallet: w, transaction: refund, reference: win, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.INVALID_REFERENCE_KIND });
    expect(refund.balanceAfter?.toJSON().amount).toBe("100.00");
  });

  test("REFUND with a different amount than the BET is rejected", () => {
    const w = wallet();
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    bet.markProcessed(undefined, at);
    const refund = tx(WagerTransactionKind.Refund, "5.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const result = applyWagering({ wallet: w, transaction: refund, reference: bet, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.AMOUNT_MISMATCH });
  });

  test("ROLLBACK of a REFUND debits the refunded amount", () => {
    const w = wallet("100.00");
    const refund = tx(WagerTransactionKind.Refund, "25.00", { referenceExternalTransactionId: "bet-x" });
    refund.markProcessed("bet-id", at);
    const rollback = tx(WagerTransactionKind.Rollback, "25.00", { referenceExternalTransactionId: refund.externalTransactionId });
    applyWagering({ wallet: w, transaction: rollback, reference: refund, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    expect(w.balance.toJSON().amount).toBe("75.00");
  });

  test("reference from another round is rejected", () => {
    const w = wallet();
    const bet = WagerTransaction.rehydrate({ ...tx(WagerTransactionKind.Bet, "10.00").snapshot(), roundId: "other-round", status: WagerTransactionStatus.Processed });
    const refund = tx(WagerTransactionKind.Refund, "10.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const result = applyWagering({ wallet: w, transaction: refund, reference: bet, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.ROUND_MISMATCH });
  });

  test("pending reference expires as REFERENCE_NOT_FOUND after the attempt limit", () => {
    const w = wallet();
    const refund = tx(WagerTransactionKind.Refund, "10.00", { referenceExternalTransactionId: "never" });
    let result;
    do {
      result = applyWagering({ wallet: w, transaction: refund, alreadyRefunded: false, alreadyRolledBack: false, now: at, ledgerId: "l1" });
    } while (result.outcome === "pending_reference");
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.REFERENCE_NOT_FOUND });
    expect(refund.retryAttempts).toBe(PENDING_REFERENCE_MAX_ATTEMPTS);
  });

  test("payload hash is canonical: key order does not matter, values do", () => {
    expect(payloadHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHashOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(payloadHashOf({ a: 1 })).not.toBe(payloadHashOf({ a: 2 }));
  });
});
