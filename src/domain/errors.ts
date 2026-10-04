export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_MONEY");
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(`currency mismatch: ${left} vs ${right}`, "CURRENCY_MISMATCH");
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("insufficient funds", "INSUFFICIENT_FUNDS");
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_TRANSACTION_STATE");
  }
}

export class UnbalancedLedgerError extends DomainError {
  constructor() {
    super("ledger entry is not balanced", "UNBALANCED_LEDGER");
  }
}

export class DuplicateWalletError extends DomainError {
  constructor() {
    super("wallet already exists for player and currency", "DUPLICATE_WALLET");
  }
}

export class WalletNotFoundError extends DomainError {
  constructor() {
    super("wallet not found", "WALLET_NOT_FOUND");
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor() {
    super("transaction not found", "TRANSACTION_NOT_FOUND");
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super("idempotency key reused with a different payload", "IDEMPOTENCY_PAYLOAD_CONFLICT");
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

export class TransientInfrastructureError extends DomainError {
  constructor(message: string) {
    super(message, "TRANSIENT_INFRASTRUCTURE");
  }
}
