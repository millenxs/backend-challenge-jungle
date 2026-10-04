import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const STRICT_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== "string") {
      throw new InvalidMoneyError("amount must be a string");
    }
    if (typeof props.currency !== "string" || !/^[A-Z]{3}$/.test(props.currency)) {
      throw new InvalidMoneyError("currency must be ISO-4217 (three uppercase letters)");
    }
    if (!STRICT_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError("amount must be a non-negative decimal with exactly 2 places");
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const next = this.value.minus(other.value);
    if (next.isNegative()) {
      throw new InvalidMoneyError("subtraction would produce a negative amount");
    }
    return new Money(next, this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
