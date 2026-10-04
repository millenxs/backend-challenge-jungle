import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from "../domain/errors";
import { errorFields, log } from "../infrastructure/observability";
import { classifyError } from "../infrastructure/persistence/transaction";

/**
 * 400 INVALID_PAYLOAD          → corrigir o payload; reenviar igual nunca funciona
 * 404 NOT_FOUND                → wallet/transação inexistente
 * 409 IDEMPOTENCY_CONFLICT     → key (ou externalTransactionId) já usada com outro payload
 * 409 WALLET_ALREADY_EXISTS
 * 503 TEMPORARILY_UNAVAILABLE  → infraestrutura; seguro reenviar com a MESMA Idempotency-Key
 * 500 INTERNAL_ERROR
 * (422 rejeição de negócio e 202 pendente não são exceções: ver WageringController)
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, body] = toHttp(error);
    if (status >= 500) log("error", "request failed", errorFields(error));
    if (status === 503) response.setHeader("Retry-After", "1");
    response.status(status).json(body);
  }
}

function toHttp(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 503) return [503, error.getResponse() as Record<string, unknown>];
    const code = status === 400 ? "INVALID_PAYLOAD" : status === 404 ? "NOT_FOUND" : "HTTP_ERROR";
    return [status, { error: code, message: error.message }];
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return [404, { error: "NOT_FOUND", message: error.message }];
  }
  if (error instanceof IdempotencyConflictError) return [409, { error: "IDEMPOTENCY_CONFLICT", message: error.message }];
  if (error instanceof DuplicateWalletError) return [409, { error: "WALLET_ALREADY_EXISTS", message: error.message }];
  switch (classifyError(error)) {
    case "invalid":
      return [400, { error: "INVALID_PAYLOAD", message: error instanceof ZodError ? error.issues : String((error as Error).message) }];
    case "business":
      return [422, { error: (error as { code?: string }).code ?? "BUSINESS_RULE", message: (error as Error).message }];
    case "transient":
      return [503, { error: "TEMPORARILY_UNAVAILABLE", message: "infrastructure unavailable, retry with the same Idempotency-Key" }];
    default:
      return [500, { error: "INTERNAL_ERROR", message: "unexpected error" }];
  }
}
