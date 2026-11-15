# Relé do ISPM SMS

Worker da Cloudflare que guarda, por pareamento, os pedidos cifrados entre o ISPM e a app ISPM SMS quando o telemóvel está fora da rede local. Só vê envelopes cifrados; o desenho está em `docs/adr/0024-rele-cifrado-sms.md`.

## Instalar

Precisa de uma conta Cloudflare (o plano gratuito chega) e do Node.

```sh
cd relay-worker
npx wrangler login
npx wrangler deploy
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put RELAY_ADMIN_KEY
```

O `deploy` mostra o endereço do Worker (`https://ispm-sms-relay.<conta>.workers.dev`). O terceiro comando gera a chave de administração; cole-a quando o quarto a pedir.

No ISPM, em Definições › SMS, escreva o endereço e a mesma chave e carregue em "Guardar relé". O telemóvel recebe o endereço na próxima vez que estiver na rede local do computador.

## Rotas

Todas em `/m/<caixa>/`, com `Authorization: Bearer <credencial>`. A caixa e as credenciais derivam do segredo do pareamento.

| Rota | Quem | O que faz |
|---|---|---|
| `POST /register` | chave de administração | cria a caixa com os hashes das duas credenciais |
| `POST /requests/<id>` | ISPM | deixa um pedido |
| `GET /requests` | telemóvel | recolhe os pedidos por responder |
| `POST /responses/<id>` | telemóvel | deixa a resposta |
| `GET /responses/<id>` | ISPM | lê a resposta (204 enquanto não há) |
| `DELETE /responses/<id>` | ISPM | retira a troca da caixa |

## Limites

- 64 mensagens e 16 MB por caixa; cerca de 1 MB por mensagem.
- Cada mensagem expira no prazo que traz (no máximo 6 minutos).
- Uma caixa sem uso há 90 dias apaga-se.
- Sem registos: nada do que passa fica escrito.

## Testes

Correm com os do ISPM: `npx vitest run relay-worker src/backend/lib/sms-relay.test.ts`.
