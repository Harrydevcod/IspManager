# ADR 0013: Fornecedor de WhatsApp escolhido por configuração

## Estado

Aceite e implementado. A parte dos modelos aprovados da Meta fica por fazer (ver "O que fica de fora").

## Contexto

O ISPM enviava WhatsApp só pelo UltraMsg, um serviço não oficial que liga um número pessoal. O outbox
(`whatsapp-outbox.ts`) já tinha uma costura para trocar o transporte, mas com a forma do UltraMsg: os
envios recebiam `instanceId` e `token`, e cinco sítios liam `ultraMsgInstanceId`/`ultraMsgToken`
diretamente. Um deles lia o token sem passar pelo cofre e mandava ao UltraMsg o texto cifrado.

A alternativa oficial é a WhatsApp Cloud API da Meta. Tem outras credenciais, outro formato de pedido, e
duas diferenças de comportamento que pesam no desenho:

1. **Janela de 24 horas.** A Meta só aceita texto livre até 24 h depois de o cliente escrever à empresa.
   Fora disso exige um modelo pré-aprovado. Os avisos do ISPM (fatura, atraso, corte) são quase sempre
   iniciados pela empresa.
2. **Estados de entrega só por webhook.** O ISPM corre num PC sem endereço público e não os pode receber.

## Decisão

Quem leva a mensagem é um `WhatsappProvider` (`src/backend/lib/whatsapp-provider.ts`):

- `sendText({ to, body })` e `sendDocument({ to, document, filename, caption })`, com o documento em
  `Buffer`. Cada fornecedor codifica como precisa: o UltraMsg em base64, a Meta num carregamento prévio.
- `fetchStatuses?()` é opcional. O UltraMsg tem; a Meta não, e a sondagem de entregas salta.
- As mensagens são objetos e não argumentos posicionais, para um futuro campo `template` ser aditivo.

`resolveWhatsappProvider(db)` é a única fábrica. Lê `app_settings.whatsappProvider` (`ultramsg` por
omissão, `meta-cloud`) e as credenciais pelo cofre (`secrets.ts`). Devolve `null` quando falta uma
credencial ou o cofre não a abre, e quem chama trata isso como "não configurado". **O fornecedor
escolhido nunca é trocado pelo outro em silêncio**, mesmo que o outro esteja configurado.

O outbox, as rotas e o trabalho dos avisos falam só com esta interface. A linha do outbox fica marcada
com o fornecedor que a enviou de facto (`provider`), porque o `provider_message_id` só faz sentido junto
dele; a sondagem só olha para as linhas do fornecedor ativo.

O token da Meta é mais uma credencial do cofre (`metaAccessToken`), com o mesmo protocolo do ADR 0012.

## O que fica de fora

- **Modelos aprovados da Meta.** Com a Meta ativa, um aviso fora da janela de 24 h falha com um erro
  que diz isso mesmo (código 131047 da Graph API). Suportá-los pede guardar no outbox o evento e as
  variáveis em vez do texto já montado, e configurar o nome do modelo por evento.
- **Webhooks de estado.** Com a Meta, as mensagens ficam em "enviado"; não há entregue nem lido.

## Consequências

- Acrescentar um fornecedor é implementar a interface e um ramo na fábrica; nada mais muda.
- Sem migração: `whatsappProvider`, `metaPhoneNumberId` e `metaAccessToken` vivem em `app_settings`, e
  a coluna `whatsapp_outbox.provider` já existia.
- A versão da Graph API está fixa em `meta-cloud.ts` e tem de ser revista quando a Meta a retirar.
