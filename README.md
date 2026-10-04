# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS. Ele permanece correto com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

- **Stack:** Bun 1.3, TypeScript strict, NestJS 11, MikroORM 6, PostgreSQL 16 e AWS SQS (LocalStack).
- **Enunciado:** [CHALLENGE.md](CHALLENGE.md).
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) ≥ 1.3
- Docker com Docker Compose

## Setup

```bash
bun install
docker compose up -d --wait      # PostgreSQL + LocalStack (filas criadas em localstack/ready.d)
bun run migration:up
bun run start                    # http://localhost:3000
```

Os defaults já apontam para o docker compose local. Para mudar algo, copie `.env.example` para `.env`; o Bun carrega esse arquivo automaticamente.

### Várias instâncias

Para rodar várias instâncias localmente, use processos com portas diferentes, todos ligados ao mesmo banco e à mesma fila:

```bash
PORT=3001 bun run start & PORT=3002 bun run start & PORT=3003 bun run start &
```

Ou rode a aplicação em container:

```bash
docker compose --profile app up -d --build --scale app=3
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | API, consumidor SQS, publisher da outbox e worker de referências pendentes |
| `bun run start:dev` | Igual ao anterior, com watch |
| `bun run migration:up` / `migration:down` | Aplica ou reverte a migration |
| `bun run test` | Typecheck + testes de unidade (não precisa de Docker) |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Concorrência e recuperação com 3 processos reais da aplicação |
| `bun run test:all` | Tudo |

Os testes de integração e de concorrência precisam do `docker compose up -d --wait` e criam os próprios dados (o ledger é imutável, então nada é apagado).

## API

| Método | Rota | Observação |
|---|---|---|
| `POST` | `/wallets` | `{ playerId, initialBalance: { amount, currency } }` → `201`. Duplicada → `409` |
| `GET` | `/wallets/:walletId` | |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | Cursor opaco, `limit` ≤ 200 |
| `POST` | `/wallets/:walletId/reconciliation` | Compara o saldo materializado com o ledger |
| `POST` | `/wagering/transactions` | Header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET` | `/health/live`, `/health/ready` | Públicos. `ready` checa PostgreSQL e SQS |
| `GET` | `/metrics` | Prometheus |

Status de `POST /wagering/transactions`:

| Status | Significado |
|---|---|
| `200` | Processada |
| `202` | Aguardando a referência |
| `400` | Payload inválido |
| `409` | Conflito de idempotência |
| `422` | Rejeitada por regra de negócio, com `failureCode` |
| `503` | Infraestrutura indisponível; reenvie com a mesma key |

A tabela completa e a taxonomia de `failureCode` estão no [ARCHITECTURE.md](ARCHITECTURE.md#5-idempotência-e-api-http).

### Exemplo

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

### Enviando pela fila

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...,"idempotencyKey":"provider-a:transaction-123"}}'
```

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras (sem Nest/ORM)
  application/     use cases (WageringService, WalletService) e contratos zod
  http/            controllers e mapeamento de erros → status
  infrastructure/  persistence (MikroORM, migration), messaging (SQS, outbox), workers, observabilidade, auth
tests/
  unit/            domínio
  integration/     PostgreSQL + LocalStack reais
  concurrency/     3 instâncias reais, crash/restart
```
