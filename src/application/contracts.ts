import { z } from "zod";
import type { FailureCode, WagerTransactionStatus } from "../domain/enums";
import type { MoneyProps } from "../domain/money";

const moneySchema = z.object({ amount: z.string(), currency: z.string() });
const id = (max: number) => z.string().min(1).max(max);

/** OPENING fica de fora: é interno e não pode chegar pela API nem pela fila. */
export const wagerRequestSchema = z.object({
  providerId: id(64),
  externalTransactionId: id(128),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: id(128),
  gameId: id(128),
  kind: z.enum(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
  money: moneySchema,
  referenceExternalTransactionId: id(128).optional(),
});
export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export const idempotencyKeySchema = id(256);

export const wagerMessageSchema = z.object({
  messageId: id(128),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string(),
  data: wagerRequestSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});
export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export const createWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema,
});

export const uuidSchema = z.string().uuid();

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
