# Android SMS Companion Design

**Data:** 2026-06-04  
**Estado:** Aprovado para especificacao  
**Ambito:** ISPM desktop, backend local, UI de configuracoes/pagamentos, app Android companion

## Objetivo

Adicionar envio de notificacoes por SMS usando o SIM/numero do telemovel Android do operador, sem depender de gateway SMS externo e sem automatizar o Phone Link do Windows.

O envio sera mediado por um app Android companion na mesma rede local. O ISPM desktop cria pedidos de SMS, mantem fila/retries/auditoria e envia para o Android pareado. O Android mostra cada SMS para aprovacao manual; apenas apos aprovacao o SMS e enviado pelo SIM do telemovel.

## Decisoes Confirmadas

- O telemovel emissor e Android.
- O desktop ISPM e o Android estarao normalmente na mesma rede local/Wi-Fi.
- O envio exige aprovacao manual no Android antes de usar o SIM.
- O Android aceita pedidos apenas de um ISPM pareado.
- O pareamento usa QR code/codigo com chave compartilhada local.
- O desktop mantem fila e retry/backoff quando o Android estiver offline.

## Fora de Escopo

- Gateway SMS externo.
- Relay cloud.
- Envio automatico sem aprovacao no Android.
- Automacao do Phone Link.
- Recebimento/processamento de respostas SMS dos clientes.
- Suporte iPhone.

## Eventos SMS

O sistema deve suportar templates e envio para estes eventos:

- `invoice_issued`: notificacao de emissao de fatura (`FT`).
- `receipt_confirmed`: confirmacao de recibo/pagamento (`FR`).
- `payment_overdue`: notificacao de atraso de pagamento.
- `suspension_notice`: aviso de suspensao por falta de pagamento.

Cada template deve usar os mesmos termos de dominio do ISPM: cliente, servico, plano, fatura, recibo, vencimento, valor em CVE e dias de atraso.

## Arquitetura

### Desktop ISPM

O backend local ganha uma outbox de SMS, separada do WhatsApp para manter o canal explicito e reduzir acoplamento com UltraMsg.

Tabela proposta: `sms_outbox`.

Campos principais:

- `id`
- `client_id`
- `payment_id`
- `service_id`
- `event_type`
- `to_phone`
- `body`
- `status`
- `attempts`
- `max_attempts`
- `last_error`
- `next_attempt_at`
- `android_request_id`
- `approved_at`
- `sent_at`
- `rejected_at`
- `created_at`
- `updated_at`

Estados:

- `pending_dispatch`: criado no desktop, ainda nao entregue ao Android.
- `pending_approval`: entregue ao Android, aguardando aprovacao.
- `approved`: aprovado no Android, envio iniciado.
- `sent`: Android confirmou envio ao sistema SMS.
- `failed`: falhou de forma recuperavel ou terminal, com `last_error`.
- `rejected`: operador rejeitou no Android.
- `cancelled`: cancelado no desktop antes do envio.

O backend tambem ganha configuracoes:

- `smsCompanionEnabled`
- `smsCompanionDeviceName`
- `smsCompanionBaseUrl`
- `smsCompanionPairingKeyHash`
- `smsInvoiceIssuedTemplate`
- `smsReceiptConfirmedTemplate`
- `smsPaymentOverdueTemplate`
- `smsSuspensionNoticeTemplate`
- `smsDispatchIntervalSeconds`
- `smsRetryGraceMinutes`

### Android Companion

O app Android funciona como servidor local pareado e aprovador de envios.

Responsabilidades:

- Parear com um unico ISPM via QR code/codigo.
- Receber pedidos assinados do desktop.
- Persistir pedidos localmente.
- Mostrar lista de SMS pendentes.
- Permitir aprovar ou rejeitar cada SMS.
- Enviar SMS pelo SIM apos aprovacao.
- Expor status para o desktop consultar.
- Mostrar historico local basico: pendente, enviado, falhado, rejeitado.

O app deve pedir as permissoes Android necessarias para SMS no momento adequado e explicar claramente que o envio usa o numero/SIM do telemovel.

## Pareamento e Seguranca

O pareamento acontece em `Configuracoes > SMS`:

1. O desktop gera uma chave aleatoria forte.
2. O desktop mostra QR code com dados de pareamento.
3. O Android escaneia o QR code.
4. O Android grava a chave e o endereco do desktop.
5. O desktop grava identificador/nome do dispositivo e hash da chave.

Cada request desktop -> Android deve ser assinada com HMAC usando a chave pareada. A assinatura deve cobrir metodo, path, timestamp, nonce e body. O Android rejeita requests com assinatura invalida, timestamp expirado ou nonce repetido.

O desktop deve ter acao de revogar pareamento. O Android deve ter acao de apagar pareamento.

## Data Flow

### Criacao de SMS

1. Um evento no ISPM chama `enqueueSmsNotification`.
2. O backend renderiza o template com dados do cliente/pagamento/servico.
3. Uma linha `sms_outbox` nasce como `pending_dispatch`.
4. O worker tenta entregar ao Android pareado.

### Entrega ao Android

1. Worker seleciona linhas `pending_dispatch` vencidas.
2. Envia `POST /requests` ao Android companion.
3. Se o Android aceitar, desktop marca `pending_approval`.
4. Se o Android estiver offline, desktop agenda retry com backoff.

### Aprovacao

1. Android mostra o pedido pendente.
2. Operador aprova ou rejeita.
3. Se rejeitar, Android guarda `rejected`.
4. Se aprovar, Android envia SMS pelo SIM e guarda `sent` ou `failed`.
5. Desktop faz polling de status em `GET /requests/:id` ou recebe update se o Android conseguir contactar o desktop.

## UI Desktop

### Configuracoes > SMS

Controles:

- Ativar/desativar SMS companion.
- Parear Android.
- Mostrar status: nao pareado, pareado offline, pareado online.
- Revogar pareamento.
- Editar templates por evento.
- Enviar SMS de teste para um numero informado.
- Ver ultimos pedidos com status.

### Pagamentos

Adicionar acoes SMS ao lado dos fluxos existentes:

- Enviar SMS de fatura para pagamentos pendentes/em atraso.
- Enviar SMS de recibo para pagamentos pagos.
- Enviar SMS de atraso.
- Enviar SMS de aviso de suspensao.

O clique no desktop cria ou reusa um pedido na outbox e informa que o envio aguarda aprovacao no Android.

## UI Android

Tela principal:

- Estado de pareamento.
- Lista de SMS pendentes de aprovacao.
- Cada item mostra cliente, telefone, evento, texto e origem.
- Acoes: Aprovar, Rejeitar.

Historico:

- Enviados.
- Falhados.
- Rejeitados.

O app deve evitar envio em lote sem revisao. A aprovacao e por mensagem para a primeira versao.

## Erros e Operacao Offline

- Android offline: desktop mantem `pending_dispatch`, agenda retry e mostra status.
- Permissao SMS ausente: Android marca erro e orienta habilitar permissao.
- Falha no envio pelo SIM: Android marca `failed`; desktop reflete `failed`.
- Assinatura invalida: Android rejeita sem criar pedido.
- Pedido duplicado: Android trata `android_request_id`/idempotency key e nao duplica envio.

## Auditoria

O desktop deve registrar eventos criticos:

- Pareamento criado.
- Pareamento revogado.
- SMS enfileirado.
- SMS entregue ao Android.
- SMS aprovado.
- SMS rejeitado.
- SMS enviado.
- SMS falhou.

O texto do SMS enviado deve ficar consultavel por administrador, porque e comunicacao operacional com cliente.

## Testes

Backend:

- Renderizacao de templates SMS por evento.
- Enqueue cria `pending_dispatch`.
- Worker marca `pending_approval` quando Android aceita.
- Worker agenda retry quando Android offline.
- Poller atualiza `sent`, `failed` e `rejected`.
- HMAC assina requests com timestamp/nonce.
- Rotas de configuracao protegem pareamento por perfil admin.

Android:

- Pareamento por QR/codigo.
- Rejeicao de assinatura invalida.
- Lista de pendentes.
- Aprovar chama envio SMS.
- Rejeitar atualiza status.
- Idempotencia contra pedido duplicado.

Integracao:

- Desktop cria SMS de FT/FR/atraso/suspensao e Android recebe `pending_approval`.
- Status final volta ao desktop.

## Riscos

- Fabricantes Android podem limitar SMS em background. Mitigacao: envio acontece apos aprovacao foreground no app.
- Rede local pode mudar IP. Mitigacao: permitir atualizar endereco do Android e, numa fase futura, descoberta local.
- Uso de numero pessoal exige controle. Mitigacao: aprovacao manual, auditoria e revogacao de pareamento.
- Permissoes SMS sao sensiveis. Mitigacao: companion app minimo, sem leitura de SMS recebidos na primeira versao.

## Plano de Entrega Recomendado

Fase 1:

- Outbox SMS no desktop.
- Configuracoes e templates.
- Android companion minimo: parear, receber, aprovar/rejeitar, enviar SMS.
- Polling de status.

Fase 2:

- Melhorias de descoberta local.
- Dashboard de status SMS.
- Preferencias por cliente/canal.
- Reenvio manual e cancelamento operacional.
