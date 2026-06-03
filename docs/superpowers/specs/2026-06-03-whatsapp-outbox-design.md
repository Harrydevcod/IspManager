# WhatsApp Fase 1 — Robustecer UltraMsg (outbox) — Design

**Data:** 2026-06-03
**Estado:** Aprovado
**Âmbito:** Backend (Fastify + better-sqlite3) + pequena UI em Pagamentos

## Objetivo

Robustecer a integração WhatsApp existente (UltraMsg, outbound) com três
capacidades pedidas: **anexar PDF** (fatura/recibo), **retries + fila de envio**,
e **estado de entrega por polling**. Tudo viável num app desktop com backend em
`127.0.0.1` (sem URL pública → sem webhooks; estado obtém-se por polling).

A Fase 2 (abstração multi-provider para a Cloud API oficial da Meta) é um ciclo
separado; esta fase deixa a costura pronta.

## Restrições confirmadas (UltraMsg)

- `POST /messages/document` aceita `token, to, filename, document` (URL **ou
  base64**), `caption`. → anexar PDF por base64.
- `GET /messages` filtra por `status` (`sent/queue/unsent/invalid/all`),
  paginado (`limit≤100`, `sort`). **Não há lookup por id** → o estado obtém-se
  listando os enviados e casando pelo `id` que o envio devolve.
- O envio (`/messages/chat`) devolve um `id` que o `sendViaUltraMsg` atual
  descarta — passa a ser capturado.

## Arquitetura — outbox persistente

Os três pedidos unem-se numa tabela `whatsapp_outbox` drenada por um worker
in-process (mesmo padrão dos jobs `runXIfDue` no boot). É a única via de envio:
torna retries e estado possíveis e mantém o envio num só sítio.

### Migration `0014_whatsapp_outbox`

```sql
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','document')) DEFAULT 'text',
  body TEXT,                       -- texto, ou caption do documento
  doc_payment_id INTEGER REFERENCES payments(id),
  doc_kind TEXT CHECK(doc_kind IN ('invoice','receipt')),
  client_id INTEGER REFERENCES clients(id),
  origin TEXT NOT NULL CHECK(origin IN ('manual','auto')) DEFAULT 'manual',
  provider TEXT NOT NULL DEFAULT 'ultramsg',
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','delivered','read','failed','cancelled')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  next_attempt_at TEXT,            -- quando tentar a seguir (null = já)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_ready ON whatsapp_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_provider_msg ON whatsapp_outbox(provider_message_id);
```

Documentos guardam a **referência** (`doc_payment_id`+`doc_kind`), não o blob — o
PDF é regenerado no envio, garantindo a versão atual e mantendo a tabela leve.

### Migration `0015_whatsapp_notices_outbox_link`

`ALTER TABLE whatsapp_notices ADD COLUMN outbox_id INTEGER REFERENCES whatsapp_outbox(id);`
(ADD COLUMN é seguro em SQLite — sem rebuild de CHECK, ao contrário de
[[ispm-sqlite-check-constraint-gotcha]].)

## Transporte (`lib/ultramsg.ts` estendido)

- `sendViaUltraMsg(...)` passa a devolver `{ ok, result, messageId? }` (parse do
  `id` da resposta).
- `sendDocumentViaUltraMsg(instanceId, token, to, base64, filename, caption)` →
  `/messages/document`.
- `fetchUltraMsgSentMessages(instanceId, token, { limit, page })` →
  `GET /messages?status=sent&sort=desc`, devolve `Array<{ id, ack, ... }>`;
  helper `mapAckToStatus(ack)` → `'sent'|'delivered'|'read'`.

Estes ficam UltraMsg-específicos; o worker chama-os através de um `dispatch(row)`
interno — **a costura da Fase 2** (interface `WhatsappProvider` + fábrica por
configuração) entra aí sem mexer no outbox/poller.

## Motor (`lib/whatsapp-outbox.ts`)

- `enqueueWhatsapp(entry)` — insere linha `pending`.
- `runWhatsappOutboxIfDue(now?, deps?)` — drena `pending` com
  `next_attempt_at <= now` (ou null), lote limitado; para cada linha: monta o
  payload (texto, ou regenera PDF via `renderPaymentDocumentPdf`) e chama
  `dispatch`. Sucesso → `status='sent'` + `provider_message_id`. Falha →
  `attempts++`; se `attempts >= max_attempts` → `failed`, senão
  `next_attempt_at = now + backoff(attempts)` (exponencial: 1, 5, 15, 60 min…).
  Idempotente; `deps` injetáveis (send/sendDocument) para teste.
- `pollWhatsappDeliveryIfDue(now?, deps?)` — busca enviados recentes e avança
  linhas em (`sent`,`delivered`) para `delivered`/`read` casando
  `provider_message_id`. Injeta `fetchSent` para teste.
- Toggle `ISPM_WHATSAPP_OUTBOX=off`; intervalos em Configurações. Agendados no
  boot (`server.ts`) como `runOverdueNoticesIfDue` — nunca bloqueiam o boot.

## Reuso (`routes/documents.ts`)

Extrair e exportar `renderPaymentDocumentPdf(paymentId, kind): Promise<Buffer>`
(carrega a row + numeração + `pdfBuffer`). A rota HTTP existente
(`/api/payments/:id/invoice.pdf` / `receipt.pdf`) e o worker passam a usá-la —
fonte única do PDF.

## Pontos de integração

- `POST /api/whatsapp/send` — enfileira e **processa essa linha inline** (drena
  só aquele id) para feedback imediato; devolve o estado resultante.
- Novo `POST /api/payments/:id/whatsapp { kind: 'invoice'|'receipt' }` —
  valida pagamento + telefone do cliente, enfileira uma linha `document`.
  Botão "Enviar por WhatsApp" no módulo Pagamentos (no preview do documento).
- `lib/notices.ts` refatorado: mantém o dedup/cooldown contra `whatsapp_notices`,
  mas **enfileira** (`origin:'auto'`) em vez de enviar sincronamente — os
  auto-avisos ganham retries. Escreve a linha `whatsapp_notices` no enqueue
  (preserva dedup) e liga via `outbox_id`. O estado de entrega vive no outbox.

## Tratamento de erros

- Sem `ultraMsgInstanceId`/`token` → `400` nas rotas (como hoje); o worker marca
  a linha `failed` com `last_error` claro e não faz busy-loop.
- Falha de rede/provider → retry com backoff até `max_attempts`, depois `failed`.
- PDF que não gera (pagamento inexistente/anulado) → linha `failed` com motivo,
  sem abortar o lote.
- Poller tolerante a falhas de rede (tenta no próximo intervalo).

## Testes (Vitest)

- **Transporte:** parse do `messageId`; shape do envio de documento (base64,
  filename); `mapAckToStatus`; `fetchUltraMsgSentMessages` (fetch mockado).
- **Motor:** enqueue cria `pending`; drain com sucesso → `sent`+`provider_message_id`;
  falha agenda backoff crescente; `max_attempts` → `failed`; poller avança
  `sent→delivered→read` casando id; idempotência.
- **Rotas:** `/api/whatsapp/send` enfileira+processa; `/api/payments/:id/whatsapp`
  enfileira `document` (e 400 sem telefone/instance/token); `notices` enfileira
  em vez de enviar (com dedup intacto).

Cleanup de testes respeita ordem child-first (FKs) — ver
[[ispm-fk-and-test-flakiness]]; correr suite com `--no-file-parallelism`.

Validação: `npm.cmd run typecheck`, `npm.cmd test`, `npx.cmd tsc -p tsconfig.main.json`.

## Fora de scope

- Inbound / leitura de respostas.
- Abstração multi-provider e Cloud API oficial (Fase 2, ciclo próprio — a costura
  `dispatch()` fica pronta). Ver [[ispm-data-quality-reports]] para o padrão de
  feature recente.
- Webhooks (incompatíveis com localhost).
