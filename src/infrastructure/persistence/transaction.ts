import {
  ConstraintViolationException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  type MikroORM,
} from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ZodError } from "zod";
import {
  DomainError,
  InvalidMoneyError,
  TransientInfrastructureError,
  ValidationError,
} from "../../domain/errors";
import { metrics } from "../observability";

const MAX_LOCK_ATTEMPTS = 3;

/**
 * Executa `work` numa transação SQL própria (fork do EntityManager — nada de contexto global).
 * Lock timeout e deadlock são retentados algumas vezes; o resto sobe para o chamador.
 */
export async function inTransaction<T>(orm: MikroORM, work: (em: EntityManager) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await orm.em.fork().transactional(async (em) => {
        // lock_timeout = 5s fixo; uma hot wallet extrema pode preferir fila por wallet em vez de esperar lock
        await (em as EntityManager).execute("set local lock_timeout = '5s'");
        return work(em as EntityManager);
      });
    } catch (error) {
      const lockConflict = error instanceof LockWaitTimeoutException || error instanceof DeadlockException;
      if (!lockConflict) throw error;
      metrics.lockConflicts.inc();
      if (attempt >= MAX_LOCK_ATTEMPTS) throw error;
      metrics.retries.inc({ reason: "lock_conflict" });
    }
  }
}

export type ErrorKind = "invalid" | "business" | "transient" | "bug";

/**
 * invalid   → payload não pode ser processado nunca (HTTP 400 / DLQ)
 * business  → regra de negócio, terminal (HTTP 404/409 / ack)
 * transient → infraestrutura indisponível, pode reenviar (HTTP 503 / retry com backoff)
 * bug       → erro de programação/constraint inesperada (HTTP 500 / retry e depois DLQ)
 */
export function classifyError(error: unknown): ErrorKind {
  if (error instanceof ZodError || error instanceof ValidationError || error instanceof InvalidMoneyError) {
    return "invalid";
  }
  if (error instanceof SyntaxError) return "invalid";
  if (error instanceof TransientInfrastructureError) return "transient";
  if (error instanceof DomainError) return "business";
  if (error instanceof ConstraintViolationException) return "bug";
  if (error instanceof DriverException) return "transient";
  const code = (error as { code?: string; name?: string })?.code;
  const name = (error as { name?: string })?.name;
  if (code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03"].includes(code)) return "transient";
  if (name === "KnexTimeoutError" || name === "TimeoutError" || (error as { $retryable?: unknown })?.$retryable) {
    return "transient";
  }
  return "bug";
}
