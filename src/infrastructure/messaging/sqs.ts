import { SQSClient } from "@aws-sdk/client-sqs";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const account = process.env.AWS_ACCOUNT_ID ?? "000000000000";

export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  endpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

const queueUrl = (name: string) => `${endpoint}/${account}/${name}`;

export const queues = {
  wager: process.env.SQS_WAGER_QUEUE_URL ?? queueUrl("wager-transactions.fifo"),
  dlq: process.env.SQS_WAGER_DLQ_URL ?? queueUrl("wager-transactions-dlq.fifo"),
  events: process.env.SQS_EVENTS_QUEUE_URL ?? queueUrl("integration-events.fifo"),
};
