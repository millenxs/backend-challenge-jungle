import { FailureCode, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from "./enums";
import { InsufficientFundsError } from "./errors";
import { Wallet } from "./wallet";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import { WagerTransaction } from "./wager-transaction";

export const PENDING_REFERENCE_MAX_ATTEMPTS = 8;

export function nextReferenceAttemptAt(now: Date, attempts: number): Date {
  const delayMs = Math.min(300_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs);
}

function pendingOrExpire(tx: WagerTransaction, wallet: Wallet, now: Date): ApplyWageringResult {
  if (tx.retryAttempts >= PENDING_REFERENCE_MAX_ATTEMPTS) {
    tx.reject(FailureCode.REFERENCE_NOT_FOUND, wallet.balance);
    return { outcome: "rejected", code: FailureCode.REFERENCE_NOT_FOUND };
  }
  tx.markPendingReference(nextReferenceAttemptAt(now, tx.retryAttempts + 1));
  return { outcome: "pending_reference" };
}

export type ApplyWageringResult =
  | { outcome: "processed"; ledger?: WalletLedgerEntry }
  | { outcome: "pending_reference" }
  | { outcome: "rejected"; code: FailureCode };

export function applyWagering(input: {
  wallet: Wallet;
  transaction: WagerTransaction;
  reference?: WagerTransaction;
  alreadyRefunded: boolean;
  alreadyRolledBack: boolean;
  now: Date;
  ledgerId: string;
}): ApplyWageringResult {
  const { wallet, transaction, reference, now, ledgerId } = input;

  if (transaction.money.currency !== wallet.currency) {
    // sem saldo observado — a coluna guarda só o valor, na moeda da transação
    transaction.reject(FailureCode.CURRENCY_MISMATCH);
    return { outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH };
  }
  if (transaction.playerId !== wallet.playerId || transaction.walletId !== wallet.id) {
    transaction.reject(FailureCode.PLAYER_WALLET_MISMATCH, wallet.balance);
    return { outcome: "rejected", code: FailureCode.PLAYER_WALLET_MISMATCH };
  }

  const needsReference = transaction.requiresReference() || Boolean(transaction.referenceExternalTransactionId);
  if (needsReference) {
    if (!reference) {
      return pendingOrExpire(transaction, wallet, now);
    }

    const mismatch = validateReference(transaction, reference, input.alreadyRefunded, input.alreadyRolledBack);
    if (mismatch) {
      if (mismatch === FailureCode.REFERENCE_NOT_PROCESSED && !reference.isTerminal()) {
        return pendingOrExpire(transaction, wallet, now);
      }
      transaction.reject(mismatch, wallet.balance);
      return { outcome: "rejected", code: mismatch };
    }
  }

  if (transaction.kind === WagerTransactionKind.Loss) {
    transaction.markProcessed(reference?.id, now, wallet.balance);
    return { outcome: "processed" };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  try {
    const ledger =
      direction === LedgerDirection.Credit
        ? wallet.credit({ money: transaction.money, transactionId: transaction.id, ledgerId, at: now })
        : wallet.debit({ money: transaction.money, transactionId: transaction.id, ledgerId, at: now });
    transaction.markProcessed(reference?.id, now, wallet.balance);
    return { outcome: "processed", ledger };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      const code =
        transaction.kind === WagerTransactionKind.Bet
          ? FailureCode.INSUFFICIENT_FUNDS
          : FailureCode.REVERSAL_WOULD_MAKE_NEGATIVE;
      transaction.reject(code, wallet.balance);
      return { outcome: "rejected", code };
    }
    throw error;
  }
}

function validateReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  alreadyRefunded: boolean,
  alreadyRolledBack: boolean,
): FailureCode | undefined {
  if (reference.providerId !== transaction.providerId) {
    return FailureCode.PROVIDER_MISMATCH;
  }
  if (
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency
  ) {
    return FailureCode.PLAYER_WALLET_MISMATCH;
  }
  if (reference.roundId !== transaction.roundId) {
    return FailureCode.ROUND_MISMATCH;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.REFERENCE_NOT_PROCESSED;
  }
  if (
    (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback) &&
    !transaction.money.equals(reference.money)
  ) {
    return FailureCode.AMOUNT_MISMATCH;
  }
  if (transaction.kind === WagerTransactionKind.Win && reference.kind !== WagerTransactionKind.Bet) {
    return FailureCode.INVALID_REFERENCE_KIND;
  }
  if (transaction.kind === WagerTransactionKind.Refund) {
    if (reference.kind !== WagerTransactionKind.Bet) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }
    if (alreadyRefunded) {
      return FailureCode.REFERENCE_ALREADY_REVERSED;
    }
  }
  if (transaction.kind === WagerTransactionKind.Rollback) {
    if (
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }
    if (alreadyRolledBack) {
      return FailureCode.REFERENCE_ALREADY_REVERSED;
    }
  }
  return undefined;
}
