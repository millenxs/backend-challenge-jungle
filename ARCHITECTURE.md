# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações conhecidas. O enunciado original está em [CHALLENGE.md](CHALLENGE.md).

## 1. Visão geral

```
            HTTP (POST /wagering/transactions)          SQS wager-transactions.fifo
                         │                                        │
                         ▼                                        ▼
                  WageringController                     WagerConsumer (inbox)
                         └──────────────┬─────────────────────────┘
                                        ▼
                       WageringService.submit()   ← mesmo use case
                                        │
            ┌───────────── uma transação SQL (PostgreSQL) ─────────────┐
            │ SELECT wallet FOR UPDATE                                  │
            │ INSERT inbox ON CONFLICT DO NOTHING   (só entrada SQS)    │
            │ idempotência: busca por idempotency_key                   │
            │ applyWagering() — regras puras de domínio                 │
            │ INSERT wager_transaction, UPDATE wallet, INSERT ledger    │
            │ INSERT outbox (eventos de integração)                     │
            └───────────────────────────────────────────────────────────┘
                                        │ commit
                                        ▼
       OutboxPublisher (FOR UPDATE SKIP LOCKED) ──► SQS integration-events.fifo
       PendingReference worker (backoff)       ──► WageringService.retryPending()
```

Cada instância roda a API, o consumidor SQS, o publisher da outbox e o worker de referências pendentes. Não existe coordenador nem líder: toda a coordenação entre instâncias acontece no PostgreSQL.

### Camadas

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `applyWagering` | nada (sem Nest, sem ORM) |
| `src/application` | use cases (`WageringService`, `WalletService`) e contratos (zod) | domínio + persistência |
| `src/infrastructure` | MikroORM (records, mappers, migration), SQS, workers, observabilidade | — |
| `src/http` | controllers e mapeamento de erros para status HTTP | application |

**Trade-off:** os use cases usam o `EntityManager` do MikroORM diretamente, sem portas de repositório. Uma interface com uma única implementação seria só indireção. A fronteira que importa, o domínio livre de infraestrutura, está preservada: entidades de domínio e *records* de persistência são classes separadas, ligadas por mappers.

## 2. Modelo de domínio

- Todas as entidades têm construtor `private` e factories (`create`/`open`/`receive`/`enqueue` e `rehydrate`). `rehydrate` não revalida transições.
- **`Money`:** é imutável e guarda o valor em `decimal.js`. A entrada é uma string que precisa casar com `^(0|[1-9]\d*)\.\d{2}$`, o que rejeita `NaN`, `Infinity`, notação científica, sinal, vírgula, escala diferente de 2 e string vazia. Operações entre moedas diferentes lançam `CurrencyMismatchError`. A serialização sempre usa 2 casas.
- **`WalletLedgerEntry`:** não tem nenhum campo mutável. `create` valida `balanceBefore ± money = balanceAfter`.
- **`applyWagering`:** é uma função pura que aplica as regras da §7 sobre `Wallet` + `WagerTransaction` + referência. É testada sem banco.

### Transições de `WagerTransaction`

```
              ┌────────────► PROCESSED   (terminal)
  PENDING ────┼────────────► REJECTED    (terminal)
     │        └────────────► FAILED      (terminal, reservado)
     ▼
  PENDING_REFERENCE ──(worker)──► PROCESSED | REJECTED | PENDING_REFERENCE (attempts+1)
```

- Uma transição a partir de um estado terminal lança `InvalidTransactionStateError`, porque é erro de programação.
- `PENDING` só existe em memória durante o processamento. Nada é persistido nesse estado.
- `FAILED` está modelado, mas nenhum fluxo o usa. Falhas de infraestrutura nunca chegam a gravar a transação, porque a transação SQL é desfeita: o cliente recebe 503 (HTTP) ou a mensagem volta para a fila (SQS) e é retentada.

### Regras e interpretações adotadas

| Tema | Decisão |
|---|---|
| `WIN` com referência | Exige que a referência seja um `BET` da mesma rodada. O valor **pode** ser diferente (prêmio ≠ aposta). Referência ausente leva a `PENDING_REFERENCE`, como em REFUND/ROLLBACK. |
| `WIN` sem referência | Aceito: crédito simples. |
| Igualdade de valor | Só em `REFUND`/`ROLLBACK` (§7.5). |
| `ROLLBACK` | Inverte a direção da referência (BET → crédito; WIN/REFUND → débito). |
| Reversão dupla | É bloqueada por tipo: uma referência aceita um REFUND e um ROLLBACK, mas nunca dois do mesmo tipo. |
| Referência existente mas não processada | Se ainda está pendente, aguarda (backoff). Se é terminal mas não `PROCESSED` (ex.: `REJECTED`), a transação é rejeitada com `REFERENCE_NOT_PROCESSED`. |
| Valor zero | É rejeitado (400) em transações de provedor. Saldo inicial `0.00` é aceito e não gera `OPENING` nem ledger. |
| Replay | Devolve o resultado original, incluindo o saldo observado naquele momento (coluna `balance_after_amount`, gravada também nas rejeições). Para `PENDING_REFERENCE`, devolve o estado atual (pode já ter virado `PROCESSED`). |
| Saldo observado em `CURRENCY_MISMATCH` | Não é gravado, porque a coluna guarda só o valor e a moeda é a da transação. O replay devolve `balance: null`. |

### Taxonomia de `failureCode`

| Código | Significado | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | Não reenviar |
| `REVERSAL_WOULD_MAKE_NEGATIVE` | Reversão (ROLLBACK de WIN/REFUND) deixaria o saldo negativo. É distinto de `INSUFFICIENT_FUNDS` por exigir tratamento operacional (§7.9) | Escalar para operação |
| `REFERENCE_NOT_FOUND` | A referência não chegou dentro do TTL | Reenviar com outro `externalTransactionId`, depois de enviar a referência |
| `REFERENCE_NOT_PROCESSED` | A referência existe, mas foi rejeitada | Não reenviar |
| `INVALID_REFERENCE_KIND` | REFUND→não-BET, ROLLBACK→OPENING/LOSS/ROLLBACK, WIN→não-BET | Corrigir o payload |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida por esse tipo | Não reenviar |
| `AMOUNT_MISMATCH` | O valor de REFUND/ROLLBACK é diferente do valor da referência | Corrigir o payload |
| `CURRENCY_MISMATCH` | A moeda da operação é diferente da moeda da wallet | Corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | O player não é dono da wallet, ou a referência pertence a outra wallet/player/moeda | Corrigir o payload |
| `ROUND_MISMATCH` | A referência é de outra rodada | Corrigir o payload |
| `PROVIDER_MISMATCH` | A referência é de outro provider (defensivo, já que a busca é por `providerId`) | Corrigir o payload |

Problemas de contrato, como payload inválido, wallet inexistente ou conflito de idempotência, não viram `failureCode`: são erros HTTP (seção 5) e nada é persistido.

## 3. Persistência: MikroORM + PostgreSQL

**Por que MikroORM:** é o preferencial do desafio, oferece `em.transactional()` com rollback automático e `LockMode.PESSIMISTIC_WRITE` / `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`), e o Unit of Work agrupa as escritas de cada etapa num flush.

- **Sem contexto global:** cada unidade de trabalho usa `orm.em.fork()` (`registerRequestContext: false`). O `inTransaction()` aplica `SET LOCAL lock_timeout = '5s'` e retenta até 3 vezes em deadlock ou lock timeout.
- **Mapeamento do `Money`:** valor em `NUMERIC(19,2)` com `DecimalType` em modo string. O valor nunca passa por `number` em nenhum ponto. A moeda vai numa coluna `CHAR(3)` separada, e a reidratação usa `Money.from({ amount, currency })`.
- **Ordem de escrita:** as relações não são mapeadas como associações do ORM (só ids), então os flushes são explícitos: primeiro a transação, depois ledger e outbox, respeitando as FKs.
- **Migration:** foi escrita à mão em SQL, para que constraints e triggers fiquem visíveis e revisáveis. É reversível (`bun run migration:down`). Um teste de integração roda `up → down → up` num banco descartável e confere que tabelas, triggers e a função somem no `down`.

### Garantias aplicadas no schema (restrição 9)

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance_amount >= 0)` na wallet, e `CHECK (balance_after_amount >= 0)` no ledger |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reversão uma única vez por tipo | Índices únicos parciais `(reference_transaction_id) WHERE kind = 'REFUND' AND status = 'PROCESSED'` (e o mesmo para ROLLBACK) |
| REFUND/ROLLBACK com referência | `CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)` |
| Valor positivo | `CHECK (amount > 0)` em transações e ledger |
| Ledger: no máximo um lançamento por transação | `UNIQUE (transaction_id)` (o modelo atual tem uma wallet por transação) |
| Ledger aritmeticamente correto | `CHECK ((DEBIT AND after = before - amount) OR (CREDIT AND after = before + amount))` |
| Ledger imutável | Triggers `BEFORE UPDATE/DELETE FOR EACH ROW` e `BEFORE TRUNCATE FOR EACH STATEMENT` que lançam exceção |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |
| Ledger paginável | Índice `(wallet_id, id)`. O id é UUIDv7, ordenado no tempo |

## 4. Concorrência

**Estratégia: lock pessimista por wallet (`SELECT … FOR UPDATE`) e retry limitado.**

- **A unidade de concorrência é a linha da wallet.** Wallets diferentes nunca se bloqueiam, e não existe lock global.
- **Saldo e idempotência são decididos depois do lock.** A busca por `idempotency_key` acontece já com o lock obtido, então enxerga o commit de quem segurava o lock antes (o nível de isolamento é READ COMMITTED). Por isso 50 requisições idênticas em paralelo resultam em um processamento e 49 replays.
- **Corrida entre wallets diferentes com a mesma key:** é barrada pelo `UNIQUE`. A segunda tentativa refaz o fluxo e cai em replay ou conflito.
- **`version`:** começa em 1 e incrementa só quando o saldo muda. Com lock pessimista, o optimistic locking seria redundante, então `version` é informativo e exposto na API e nos eventos.

**Por que pessimista e não optimistic + retry:** numa *hot wallet* (muitas apostas na mesma wallet), o optimistic gera tempestades de retry e latência imprevisível. O lock serializa sem desperdício e torna os testes de race determinísticos. O custo é o throughput por wallet ficar limitado à latência de uma transação. Para wallets diferentes, a escala é linear.

**Ordem dos locks:** sempre a wallet primeiro. O worker de pendências lê a transação sem lock, trava a wallet e relê a transação. Isso evita deadlock com o caminho principal.

Os recursos FIFO do SQS (`MessageGroupId = walletId`, deduplicação) são só otimização. Os testes enviam duplicatas com `MessageDeduplicationId` diferentes justamente para provar que a garantia vem do banco.

## 5. Idempotência e API HTTP

- **Header:** `Idempotency-Key` é obrigatório (1–256 caracteres) e é a fonte da verdade. O recomendado é `"{providerId}:{externalTransactionId}"`.
- **`payloadHash`:** SHA-256 (hex) do JSON canônico do subconjunto de negócio `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId|null}`. O JSON canônico ordena as chaves recursivamente, sem espaços, com valores via `JSON.stringify`. Header e metadados de transporte (`messageId`, `occurredAt`) não entram no hash.
- **Requisição idêntica:** devolve a mesma resposta com `idempotentReplay: true`.
- **Mesma key com payload diferente, ou mesmo `externalTransactionId` com outra key:** `409 IDEMPOTENCY_CONFLICT`. Nunca é tratado como replay.

### Mapeamento de status (consistente em todos os endpoints)

| Status | Situação | Pode reenviar? |
|---|---|---|
| `200` | `PROCESSED` (também em replay) | — |
| `201` | Wallet criada | — |
| `202` | `PENDING_REFERENCE`: aceita, aguardando a referência | Sim, para consultar o estado |
| `400 INVALID_PAYLOAD` | Schema, `Money` inválido, header ausente, cursor inválido | Não, sem corrigir |
| `404 NOT_FOUND` | Wallet ou transação inexistente | — |
| `409 IDEMPOTENCY_CONFLICT` / `WALLET_ALREADY_EXISTS` | Conflito | Não |
| `422` | `REJECTED` por regra de negócio, com `failureCode` no corpo | Não (o replay devolve o mesmo 422) |
| `503 TEMPORARILY_UNAVAILABLE` | PostgreSQL ou SQS indisponível, ou lock timeout esgotado. Inclui `Retry-After` | **Sim, com a mesma `Idempotency-Key`** |
| `500` | Erro inesperado | — |

**Cursor do ledger:** é o `base64url` do id do último item (UUIDv7). É opaco e estável, porque inserções novas sempre vão para o fim da ordem.

## 6. Mensageria

### Consumidor SQS

- Faz long polling (até 10 mensagens por vez) e processa o lote em paralelo. A mesma wallet é serializada pelo banco.
- **Inbox persistente** por `(consumerName, messageId)`, gravada na mesma transação SQL do efeito financeiro. O registro é montado pela entidade de domínio `InboxMessage` (`receive` + `markProcessed`) e persistido com `INSERT … ON CONFLICT DO NOTHING` em vez de `persist`, porque capturar a violação de PK abortaria a transação inteira.
- **Ack (`DeleteMessage`) só depois do commit.**

| Classe de erro | Exemplos | Ação |
|---|---|---|
| Negócio | Wallet inexistente, conflito de idempotência | Log e **ack** (terminal). Rejeições de regra (`REJECTED`) já são resultado normal e também levam a ack |
| Inválido (permanente) | JSON quebrado, schema inválido, `Money` inválido, `OPENING` | **DLQ** imediata, com o atributo `reason` |
| Transitório (ou bug) | PostgreSQL/SQS fora, lock timeout | `ChangeMessageVisibility` com backoff `2^(n-1)` s (teto de 300s) até `maxReceives = 5`, depois **DLQ** (`RETRIES_EXHAUSTED`). A redrive policy da fila (`maxReceiveCount = 5`) é a rede de segurança |

- **SIGTERM/SIGINT:** o `main.ts` trata o sinal e chama `app.close()`. No `beforeApplicationShutdown`, os loops param de buscar mensagens e esperam o lote em andamento terminar, antes de o MikroORM fechar o pool. Depois o processo sai com código 0. O `enableShutdownHooks` do Nest não foi usado porque ele re-emite o sinal e sai com 143, que é o mesmo código de um processo morto na hora; com isso, o teste não conseguiria distinguir um encerramento limpo de um abrupto. Mensagens não concluídas voltam à fila quando o visibility timeout expira.

### Transactional Outbox

- Os eventos são gravados na mesma transação da alteração financeira, então nenhum evento existe sem commit e nenhum commit fica sem evento.
- O publisher roda em todas as instâncias: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 20`, envio sequencial (preserva a ordem por agregado), `markPublished` ou `scheduleRetry` com backoff exponencial (teto de 5 min), e commit.
- **Se o processo morre entre o envio e o commit:** o lock é liberado, outra instância republica, e o evento sai **duplicado**. O consumidor deduplica por `eventId`, que também é o `MessageDeduplicationId` do FIFO, então a duplicata é segura.
- **Eventos:** `WagerTransactionProcessed` (inclusive LOSS e OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (só com lançamento no ledger) e `WagerTransactionPendingReference` (só na primeira vez que fica pendente). Todos usam o envelope `IntegrationEvent` com `eventType` e `version` no tipo, e `data` sempre em `MoneyProps`.
- Os eventos vão para a fila `integration-events.fifo` (o desafio não define um destino).

### Referências fora de ordem

- Uma transação cuja referência ainda não existe vira `PENDING_REFERENCE` e responde `202`.
- O worker roda a cada 500 ms e pega as transações vencidas. O backoff é `min(2^(n-1) s, 5 min)`.
- **TTL: 8 tentativas, com esperas de 1+2+4+…+128 s, cerca de 4 minutos.** Depois disso, a transação vira `REJECTED / REFERENCE_NOT_FOUND`, com o evento `WagerTransactionRejected`. A justificativa: em provedores de jogo, a referência chega em segundos (corrida entre filas/instâncias). Esperar horas só atrasa a resposta definitiva ao provedor, que pode reenviar com outro id.

## 7. Observabilidade

- **Logs JSON** (inclusive os do Nest, via `JsonLogger`) com `correlationId` (header `x-correlation-id`, ou o `messageId` na entrada SQS), `messageId`, `transactionId`, `walletId` e `providerId`. Valores, saldos e payloads nunca são logados.
- **Métricas Prometheus em `GET /metrics`:**
  - `wager_transactions_total{status,source}`
  - `wager_duplicates_total{source}`
  - `wager_retries_total{reason}`
  - `wager_lock_conflicts_total`
  - `wager_dlq_messages_total{reason}`
  - `wager_outbox_lag_seconds`
  - `wager_processing_seconds{source}` (histograma)
  - `wager_reconciliation_divergences_total`
  - métricas padrão do processo
- **Health:** `GET /health/live` responde só se o processo está vivo. `GET /health/ready` faz `select 1` no PostgreSQL e `GetQueueAttributes` no SQS, e responde `503` se algum falhar. Ambos são públicos.
- **Reconciliação:** uma única query compara o saldo materializado com a soma do ledger no mesmo snapshot. Divergência não é corrigida: gera log de erro, incrementa a métrica e responde com `consistent: false`.

## 8. Autenticação

A autenticação **não foi implementada**. Ela não vale pontos e competiria com o tempo de correção financeira e concorrência.

O ponto de extensão é o `NoopAuthGuard`, registrado como `APP_GUARD` global. O desenho que eu adotaria:

- **IdP externo:** Keycloak ou Zitadel no docker compose. Cada provedor de jogos é um client OIDC usando *client credentials*.
- **Validação do JWT:** o guard valida o token pela JWKS do IdP (`iss`, `aud`, `exp`). Isso não exige tabela de usuários nem senha.
- **Identidade do provedor:** o claim (ex.: `azp`/`client_id`) precisa ser igual ao `providerId` do payload; caso contrário, `403`. É a mesma validação de domínio que se aplica às mensagens da fila, que vêm por canal interno confiável.
- **Endpoints públicos:** `OpsController` (health e métricas) fica liberado.

## 9. Testes

| Suíte | Comando | O que usa |
|---|---|---|
| Unidade | `bun run test` | Domínio puro, mais o `tsc --noEmit` |
| Integração | `bun run test:integration` | PostgreSQL e LocalStack reais, services rodando no processo do teste |
| Concorrência | `bun run test:concurrency` | **3 processos reais** da aplicação, sobre o mesmo PostgreSQL e a mesma fila |

- **Cenários da §13:**
  - 50 envios paralelos da mesma aposta;
  - o cenário 100/80/80;
  - hot wallet com 60 apostas;
  - 10 wallets em paralelo;
  - HTTP e SQS misturados na mesma wallet;
  - REFUND e ROLLBACK antes da referência;
  - worker morto depois do commit e antes do ack (`FAULT_INJECT=after-commit`);
  - processo morto no meio da carga e reiniciado;
  - dois publishers na mesma outbox (contando os envios reais ao SQS);
  - retry até a DLQ;
  - atomicidade (`FAULT_INJECT=before-commit`);
  - constraints e imutabilidade no banco.
- **Invariante final:** todo teste que move saldo termina em `expectLedgerMatchesBalance`, ou seja, `wallet.balance == Σ ledger`.
- **Isolamento sem limpeza:** cada teste usa wallets e ids próprios. Isso é necessário, porque o ledger não aceita `DELETE`/`TRUNCATE`.
- **Ganchos `FAULT_INJECT`:** são lidos de variáveis de ambiente e só existem para os testes.

## 10. Limitações conhecidas

- **O teste de `SIGTERM` é pulado no Windows**, onde não existe entrega de sinal (`TerminateProcess` é imediato). Ele foi verificado em Linux (WSL Ubuntu 24.04) e roda normalmente em CI Linux.
- **Throughput por wallet:** é limitado pelo lock pessimista (uma transação por vez por wallet). O `lock_timeout` de 5s, mais 3 tentativas, resulta em 503 numa wallet extremamente quente. A evolução seria particionar o consumo por wallet (FIFO `MessageGroupId`), o que reduz a contenção sem mudar a garantia.
- **Ordem do ledger entre instâncias no mesmo milissegundo:** o id UUIDv7 é gerado depois do lock. Mesmo assim, processos diferentes no mesmo ms podem gerar ids fora da ordem causal. A paginação continua estável. Para uma ordem causal estrita, a evolução seria gravar a `version` da wallet no lançamento, com `UNIQUE (wallet_id, version)`.
- **Ledger de partidas dobradas:** não foi implementado (é opcional). O ledger é de entrada única por wallet.
- **Teste de carga (`test:load`):** não foi implementado (é opcional).
- **DLQ:** não há reprocessamento automático. É uma decisão operacional, e a mensagem carrega o atributo `reason`.
- **`FAILED`:** está modelado, mas nenhum fluxo o produz (ver seção 2).
