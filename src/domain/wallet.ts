import { Money } from "./money";
import { CurrencyMismatchError, InsufficientFundsError } from "./errors";
import { LedgerDirection } from "./enums";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: { amount: string; currency: string };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(params: { money: Money; transactionId: string; ledgerId: string; at: Date }): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    if (this._balance.isLessThan(params.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, params.money, params.transactionId, params.ledgerId, params.at);
  }

  credit(params: { money: Money; transactionId: string; ledgerId: string; at: Date }): WalletLedgerEntry {
    this.assertSameCurrency(params.money);
    return this.apply(LedgerDirection.Credit, params.money, params.transactionId, params.ledgerId, params.at);
  }

  openingLedger(transactionId: string, ledgerId: string, at: Date): WalletLedgerEntry | undefined {
    if (this._balance.isZero()) {
      return undefined;
    }
    return WalletLedgerEntry.create({
      id: ledgerId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  snapshot(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    transactionId: string,
    ledgerId: string,
    at: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return WalletLedgerEntry.create({
      id: ledgerId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
