# ADR 0023: Emparelhamento v2 entre o ISPM e a app ISPM SMS

## Estado

Aceite (2026-11-13). Substitui o pareamento por segredo no QR (`ispm-sms://pair?secret=…`) para
pareamentos novos. Os pareamentos v1 já feitos continuam válidos.

## Contexto

O pareamento v1 tinha quatro defeitos:

1. O segredo HMAC de longa duração ia dentro do QR, e uma fotografia do ecrã chegava para o copiar.
2. O operador tinha de escrever o IP do telemóvel e o nome do aparelho.
3. "Pareado" queria dizer só que a resposta a um `/ping` assinado não era 401. O telemóvel não provava nada.
4. No telemóvel, o segredo estava em claro em `SharedPreferences`, e o pareamento não pedia impressão digital nem PIN.

Estudámos duas apps que resolvem o mesmo problema:

- **WhatsApp**: [whitepaper de segurança](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf),
  [Meta Engineering, multi-device](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/)
  e a implementação aberta whatsmeow (`pair.go`, `pair-code.go`).
  - É o computador que mostra o QR. O QR leva só chaves públicas, uma referência que roda e um segredo
    de ligação de uso único.
  - O telemóvel pede impressão digital ou PIN antes de ligar um aparelho.
  - Há uma alternativa ao QR: um código de 8 caracteres que cifra a chave efémera com PBKDF2, seguido
    de ECDH e HKDF.
- **Vínculo ao Telemóvel (Phone Link)**: análise estática do pacote `Microsoft.YourPhone 1.26092`
  (só nomes de tipos e strings; não observámos o protocolo a correr).
  - Há um diálogo de QR com expiração (`ConnectQRCodeDialog`, `QrCodeExpirationSubtitle`), seguido de
    uma confirmação em que os dois ecrãs mostram o mesmo código (`ConfirmationDialogWithProgress`).
  - A confiança fica numa `CryptoTrustRelationship` com certificados próprio e do parceiro, prazo e rotação.

## Decisão

1. **O desktop mostra o QR**: `ispm-sms://pair?v=2&k=<P-256 pública efémera>&t=<16 B uso único>&n=<hostname>`.
   A sessão vive só em memória e expira ao fim de 2 minutos.
2. **O telemóvel lê o QR** depois de passar pela impressão digital ou pelo PIN (se o aparelho tiver
   bloqueio), gera o seu par efémero e calcula:
   - `Z = ECDH`;
   - `S = HKDF(Z, salt=t, "ispm-pair-v2/hmac")`, o segredo HMAC, em hex como no v1;
   - `SAS = HKDF(Z, salt=t, "ispm-pair-v2/sas") mod 10⁶`, o código de 6 dígitos.
3. **O desktop encontra o telemóvel**: varre a /24 na porta 8765 com `GET /pair/offer?th=sha256(t)[:16]`.
   Só o telemóvel que leu aquele QR responde, com `{pub, mac = HMAC(S, "offer"‖k‖pub), model}`. O
   desktop verifica o `mac` e fica a saber o IP sem ninguém o escrever.
4. **Os dois ecrãs mostram o mesmo código.** O operador carrega em "Confirmar" no desktop, e o desktop
   envia `POST /pair/confirm` assinado com S. Só então os dois lados gravam S: o desktop no cofre
   DPAPI, o telemóvel selado com AES-GCM por uma chave não exportável do Android Keystore.
5. **Num pareamento v2, `/ping` responde assinado** (`x-ispm-response-signature`). O desktop só aceita
   "pareado" com essa assinatura válida (`smsCompanionPairingVersion = 2`).

Escolhemos P-256 e não X25519 porque o minSdk da app é 26 e o X25519 só aparece no JCA do Android a
partir da API 31/33. O `node:crypto` tem os dois.

## Consequências

- **O QR não serve depois de usado.** Quem o fotografa e corre contra o telemóvel verdadeiro obtém
  outro Z, os códigos não batem e o operador cancela. Também não se consegue escolher chaves até os
  códigos baterem: a chave do desktop vem autenticada pelo QR, e o atacante não consegue calcular o Z
  do telemóvel verdadeiro.
- **O pareamento atual não se perde** enquanto o novo não for confirmado.
- **Compatibilidade:** a app 0.11 aceita QR v1 e v2. O desktop novo só gera v2, por isso uma app 0.10
  ou anterior diz "QR inválido" e é preciso atualizá-la primeiro. Os pareamentos v1 continuam a
  funcionar sem mudança.
- **Fora de âmbito:**
  - conta e relay na nuvem (o ISPM é só da rede local);
  - vários telemóveis ao mesmo tempo;
  - rotação automática de S (revogar e parear de novo resolve);
  - código manual de 8 caracteres à WhatsApp, a acrescentar se a câmara falhar no terreno;
  - limite de pedidos nas rotas `/pair/*`: só respondem com um QR pendente e o token tem 128 bits.
