import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { wagerMessageSchema, type WagerMessage } from "../../application/contracts";
import { errorFields, log, metrics } from "../observability";
import { classifyError } from "../persistence/transaction";
import { queues, sqs } from "./sqs";

export const CONSUMER_NAME = "wager-transactions-consumer";

export interface ConsumerOptions {
  /** Igual ao maxReceiveCount da redrive policy (localstack/ready.d); a redrive é só a rede de segurança. */
  maxReceives: number;
  retryBaseSeconds: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
}

export const defaultConsumerOptions = (): ConsumerOptions => ({
  maxReceives: 5,
  retryBaseSeconds: 2,
  visibilityTimeoutSeconds: Number(process.env.SQS_VISIBILITY_TIMEOUT ?? 30),
  waitTimeSeconds: 2,
});

export class WagerConsumer {
  constructor(
    private readonly handle: (message: WagerMessage) => Promise<unknown>,
    private readonly options: ConsumerOptions = defaultConsumerOptions(),
    private readonly queueUrl = queues.wager,
  ) {}

  /** Recebe um lote e processa em paralelo (wallets diferentes não se bloqueiam; a mesma wallet serializa no banco). */
  async poll(): Promise<number> {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    await Promise.all(Messages.map((message) => this.process(message)));
    return Messages.length;
  }

  private async process(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let parsed: WagerMessage;
    try {
      parsed = wagerMessageSchema.parse(JSON.parse(message.Body ?? ""));
    } catch (error) {
      return this.deadLetter(message, "INVALID_MESSAGE", error);
    }
    const fields = {
      messageId: parsed.messageId,
      correlationId: parsed.messageId,
      walletId: parsed.data.walletId,
      providerId: parsed.data.providerId,
    };
    try {
      await this.handle(parsed);
    } catch (error) {
      const kind = classifyError(error);
      if (kind === "business") {
        log("warn", "wager message rejected by business rule", { ...fields, ...errorFields(error) });
        return this.ack(message);
      }
      if (kind === "invalid") return this.deadLetter(message, "INVALID_PAYLOAD", error, fields);
      if (receiveCount >= this.options.maxReceives) {
        return this.deadLetter(message, "RETRIES_EXHAUSTED", error, fields);
      }
      // Transitório (ou bug): devolve à fila com backoff exponencial via visibility timeout.
      const delay = Math.min(this.options.retryBaseSeconds * 2 ** (receiveCount - 1), 300);
      metrics.retries.inc({ reason: "sqs_transient" });
      log("warn", "wager message will be retried", { ...fields, receiveCount, delay, ...errorFields(error) });
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delay,
        }),
      );
      return;
    }
    if (process.env.FAULT_INJECT === "after-commit") {
      // gancho do teste "worker morre depois do commit e antes do ack"
      log("error", "fault injected: exiting after commit, before ack", fields);
      process.exit(1);
    }
    await this.ack(message);
  }

  private async ack(message: Message): Promise<void> {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async deadLetter(message: Message, reason: string, error: unknown, fields: object = {}): Promise<void> {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.dlq,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dlq",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
      }),
    );
    await this.ack(message);
    metrics.deadLettered.inc({ reason });
    log("error", "wager message sent to DLQ", { ...fields, reason, ...errorFields(error) });
  }
}
