import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";
import type { Response } from "express";
import {
  createWalletSchema,
  idempotencyKeySchema,
  uuidSchema,
  wagerRequestSchema,
} from "../application/contracts";
import { WageringService } from "../application/wagering.service";
import { MAX_LEDGER_PAGE, WalletService } from "../application/wallet.service";
import { WagerTransactionStatus } from "../domain/enums";
import { queues, sqs } from "../infrastructure/messaging/sqs";
import { register } from "../infrastructure/observability";

const correlation = (header?: string) => header || Bun.randomUUIDv7();
const uuidParam = (value: string) => uuidSchema.parse(value);

@Controller("wallets")
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Headers("x-correlation-id") correlationId?: string) {
    return this.wallets.create(createWalletSchema.parse(body), correlation(correlationId));
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.wallets.get(uuidParam(walletId));
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > MAX_LEDGER_PAGE) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`);
    }
    return this.wallets.ledger(uuidParam(walletId), cursor, size);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string) {
    return this.wallets.reconcile(uuidParam(walletId));
  }
}

/** 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED — replays devolvem o mesmo status. */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    const key = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) throw new BadRequestException("Idempotency-Key header is required (1-256 chars)");
    const result = await this.wagering.submit(key.data, wagerRequestSchema.parse(body), {
      correlationId: correlation(correlationId),
      source: "http",
    });
    response.status(STATUS_CODE[result.status]);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  get(@Param("transactionId") transactionId: string) {
    return this.wagering.getById(uuidParam(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternal(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    return this.wagering.getByExternalId(providerId, externalId);
  }
}

/** Públicos: health e métricas não passam por autenticação (README §2). */
@Controller()
export class OpsController {
  constructor(private readonly orm: MikroORM) {}

  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  @Get("health/ready")
  async ready() {
    const [database, queue] = await Promise.allSettled([
      this.orm.em.getConnection().execute("select 1"),
      sqs.send(new GetQueueAttributesCommand({ QueueUrl: queues.wager, AttributeNames: ["QueueArn"] })),
    ]);
    const checks = {
      database: database.status === "fulfilled" ? "up" : "down",
      sqs: queue.status === "fulfilled" ? "up" : "down",
    };
    if (database.status === "rejected" || queue.status === "rejected") {
      throw new ServiceUnavailableException({ status: "not_ready", ...checks });
    }
    return { status: "ok", ...checks };
  }

  @Get("metrics")
  @Header("Content-Type", register.contentType)
  metrics() {
    return register.metrics();
  }
}
