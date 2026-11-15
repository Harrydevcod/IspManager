# ADR 0013: Fornecedor de WhatsApp escolhido por configuração

## Estado

Aceite e implementado, incluindo modelos de texto aprovados da Meta.

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

- **Componentes avançados dos modelos.** O ISPM suporta modelos com corpo de texto e rodapé;
  modelos com cabeçalho, botões ou outros componentes não são apresentados para seleção.
  O envio de documentos continua sujeito à janela de 24 horas.
- **Webhooks de estado.** Com a Meta, as mensagens ficam em "enviado"; não há entregue nem lido.

## Modelos aprovados

O administrador configura o ID da conta WhatsApp Business e consulta os modelos
aprovados com o token guardado no cofre. A consulta requer a permissão
`whatsapp_business_management`. Para cada evento, escolhe o nome e o idioma e
compara o texto aprovado com o texto do ISPM. Os textos têm de coincidir depois
de numerar os campos. Os campos do ISPM são preenchidos
pela ordem em que aparecem; o número e a sequência dos parâmetros têm de coincidir.

Antes de criar um aviso, o ISPM confirma que o modelo continua aprovado. A fila
guarda o nome, o idioma e os valores concretos para que uma alteração posterior
não os troque. Uma incompatibilidade impede o envio e é registada no resultado
do automatismo. Uma mensagem preparada para a Meta não é enviada pelo UltraMsg
se o fornecedor mudar enquanto ela está na fila.

## Consequências

- Acrescentar um fornecedor é implementar a interface e um ramo na fábrica; nada mais muda.
- As opções do fornecedor vivem em `app_settings` e o token no cofre. A migração
  0105 acrescenta à fila o modelo e os valores preparados para o envio.
- A versão da Graph API está fixa em `meta-cloud.ts` e tem de ser revista quando a Meta a retirar.
