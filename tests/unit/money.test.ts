import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";

describe("Money", () => {
  test("parses a two-decimal amount", () => {
    expect(Money.from({ amount: "25.00", currency: "BRL" }).toJSON()).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  test("rejects scientific notation", () => {
    expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects more than two decimal places", () => {
    expect(() => Money.from({ amount: "1.001", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects negative input amounts", () => {
    expect(() => Money.from({ amount: "-1.00", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects empty string", () => {
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("adds and subtracts in the same currency", () => {
    const a = Money.from({ amount: "10.25", currency: "BRL" });
    const b = Money.from({ amount: "0.75", currency: "BRL" });
    expect(a.add(b).toJSON().amount).toBe("11.00");
    expect(a.subtract(b).toJSON().amount).toBe("9.50");
  });

  test("rejects mixed currency arithmetic", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  test("zero is not positive", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
  });

  test("arithmetic is exact: no binary floating point rounding", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    expect(a.add(b).toJSON().amount).toBe("0.30");
    const big = Money.from({ amount: "9999999999999999.99", currency: "BRL" });
    expect(big.add(Money.from({ amount: "0.01", currency: "BRL" })).toJSON().amount).toBe("10000000000000000.00");
  });

  test("serializes with fixed scale 2", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test.each(["NaN", "Infinity", "1", "1.0", "01.00", " 1.00", "1,00", "+1.00"])("rejects %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects invalid currency codes", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
  });
});
