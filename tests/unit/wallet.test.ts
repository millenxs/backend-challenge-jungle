import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { InsufficientFundsError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/enums";

const at = new Date("2026-07-29T15:00:00.000Z");

function openWallet(balance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    at,
  });
}

describe("Wallet", () => {
  test("opens with version 1 and the given balance", () => {
    const wallet = openWallet("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe("1000.00");
  });

  test("opening ledger goes from zero to the initial balance without extra version bump", () => {
    const wallet = openWallet("1000.00");
    const entry = wallet.openingLedger("tx-open", "ledger-open", at);
    expect(wallet.version).toBe(1);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(entry?.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(entry?.isBalanced()).toBe(true);
  });

  test("debit decreases balance and increments version", () => {
    const wallet = openWallet();
    const entry = wallet.debit({
      money: Money.from({ amount: "40.00", currency: "BRL" }),
      transactionId: "tx-1",
      ledgerId: "led-1",
      at,
    });
    expect(wallet.balance.toJSON().amount).toBe("60.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  test("rejects a debit larger than the balance", () => {
    const wallet = openWallet("10.00");
    expect(() =>
      wallet.debit({
        money: Money.from({ amount: "10.01", currency: "BRL" }),
        transactionId: "tx-1",
        ledgerId: "led-1",
        at,
      }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects a currency mismatch", () => {
    const wallet = openWallet();
    expect(() =>
      wallet.credit({
        money: Money.from({ amount: "1.00", currency: "USD" }),
        transactionId: "tx-1",
        ledgerId: "led-1",
        at,
      }),
    ).toThrow();
  });
});
