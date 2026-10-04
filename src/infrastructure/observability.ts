import type { LoggerService } from "@nestjs/common";
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from "prom-client";

/**
 * Campos permitidos nos logs: ids de correlação, nunca valores nem payloads financeiros.
 */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

export function log(level: "debug" | "info" | "warn" | "error", msg: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }));
}

export function errorFields(error: unknown): { error: string; errorName?: string } {
  return error instanceof Error ? { error: error.message, errorName: error.name } : { error: String(error) };
}

/** Adapta o logger interno do Nest para o mesmo formato JSON. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    log("info", String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    log("error", String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    log("warn", String(message), { context });
  }
  debug(message: unknown, context?: string) {
    log("debug", String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    log("debug", String(message), { context });
  }
}

collectDefaultMetrics();

export const metrics = {
  transactions: new Counter({
    name: "wager_transactions_total",
    help: "Transações por status final e origem",
    labelNames: ["status", "source"] as const,
  }),
  duplicates: new Counter({
    name: "wager_duplicates_total",
    help: "Duplicatas detectadas (idempotency key ou inbox)",
    labelNames: ["source"] as const,
  }),
  retries: new Counter({
    name: "wager_retries_total",
    help: "Retentativas por motivo",
    labelNames: ["reason"] as const,
  }),
  lockConflicts: new Counter({
    name: "wager_lock_conflicts_total",
    help: "Lock timeouts e deadlocks no PostgreSQL",
  }),
  deadLettered: new Counter({
    name: "wager_dlq_messages_total",
    help: "Mensagens enviadas para a DLQ",
    labelNames: ["reason"] as const,
  }),
  outboxLag: new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Idade do evento pendente mais antigo na outbox",
  }),
  processing: new Histogram({
    name: "wager_processing_seconds",
    help: "Latência de processamento de transações",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
  reconciliationDivergences: new Counter({
    name: "wager_reconciliation_divergences_total",
    help: "Reconciliações com saldo materializado diferente do ledger",
  }),
};

export { register };
