import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { LockMode, type MikroORM } from "@mikro-orm/core";
import { applyOutboxToRecord, outboxToDomain } from "../persistence/mappers";
import { OutboxMessageRecord } from "../persistence/records";
import { errorFields, log, metrics } from "../observability";
import { queues, sqs } from "./sqs";

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly batchSize = 20,
  ) {}

  /**
   * Publica um lote de eventos vencidos e devolve quantos foram publicados.
   * SKIP LOCKED: publishers concorrentes pegam linhas disjuntas. Se o processo morrer depois do
   * envio e antes do commit, outra instância republica — o consumidor deduplica por eventId.
   */
  async publishBatch(): Promise<number> {
    const published = await this.orm.em.fork().transactional(async (em) => {
      const now = new Date();
      const records = await em.find(
        OutboxMessageRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        { orderBy: { occurredAt: "asc" }, limit: this.batchSize, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      let sent = 0;
      // Sequencial para preservar a ordem por agregado.
      for (const record of records) {
        const message = outboxToDomain(record);
        try {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: queues.events,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );
          message.markPublished(new Date());
          sent++;
        } catch (error) {
          message.scheduleRetry(new Date());
          metrics.retries.inc({ reason: "outbox_publish" });
          log("warn", "outbox publish failed", { eventId: message.id, attempts: message.attempts, ...errorFields(error) });
        }
        applyOutboxToRecord(message, record);
      }
      return sent;
    });
    await this.updateLag();
    return published;
  }

  private async updateLag(): Promise<void> {
    const [row] = await this.orm.em
      .fork()
      .getConnection()
      .execute<{ lag: string | null }[]>(
        "select extract(epoch from now() - min(occurred_at))::text as lag from outbox_messages where published_at is null",
      );
    metrics.outboxLag.set(row?.lag ? Number(row.lag) : 0);
  }
}
