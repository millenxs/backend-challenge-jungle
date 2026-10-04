import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import type { WagerMessage } from "../application/contracts";
import { WageringService } from "../application/wagering.service";
import { payloadHashOf, businessPayload } from "../domain/payload-hash";
import { OutboxPublisher } from "./messaging/outbox-publisher";
import { CONSUMER_NAME, WagerConsumer } from "./messaging/wager-consumer";
import { errorFields, log } from "./observability";

/** Repete `tick` até `stop()`. Dorme `idleMs` quando não houve trabalho ou houve erro. */
export class Loop {
  private running = false;
  private done: Promise<void> = Promise.resolve();

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly idleMs: number,
  ) {}

  start(): void {
    this.running = true;
    this.done = (async () => {
      while (this.running) {
        try {
          if ((await this.tick()) === 0 && this.idleMs > 0) await Bun.sleep(this.idleMs);
        } catch (error) {
          log("error", `${this.name} iteration failed`, errorFields(error));
          await Bun.sleep(Math.max(this.idleMs, 1000));
        }
      }
    })();
  }

  /** Termina a iteração em andamento (mensagens já recebidas são concluídas) e para. */
  async stop(): Promise<void> {
    this.running = false;
    await this.done;
  }
}

/** Liga a mensagem SQS ao mesmo use case da entrada HTTP, com dedup pela inbox. */
export function sqsHandler(wagering: WageringService) {
  return (message: WagerMessage) => {
    const { idempotencyKey, ...request } = message.data;
    return wagering.submit(idempotencyKey, request, {
      correlationId: message.messageId,
      source: "sqs",
      inbox: {
        consumerName: CONSUMER_NAME,
        messageId: message.messageId,
        payloadHash: payloadHashOf(businessPayload(request)),
      },
    });
  };
}

@Injectable()
export class Workers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: Loop[];

  constructor(orm: MikroORM, wagering: WageringService) {
    const consumer = new WagerConsumer(sqsHandler(wagering));
    const publisher = new OutboxPublisher(orm);
    this.loops = [
      new Loop("sqs-consumer", () => consumer.poll(), 0),
      new Loop("outbox-publisher", () => publisher.publishBatch(), 500),
      new Loop(
        "pending-reference-worker",
        async () => {
          const ids = await wagering.findDuePending(50);
          for (const id of ids) {
            await wagering.retryPending(id).catch((error) =>
              log("error", "pending reference retry failed", { transactionId: id, ...errorFields(error) }),
            );
          }
          return ids.length;
        },
        500,
      ),
    ];
  }

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === "false") return;
    this.loops.forEach((loop) => loop.start());
  }

  // Before (não on) shutdown: precisa terminar antes do MikroORM fechar o pool.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    log("info", "shutting down workers", { signal });
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
