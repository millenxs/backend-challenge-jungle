#!/bin/bash
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

DLQ_ARN="arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

awslocal sqs create-queue \
  --queue-name integration-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true
