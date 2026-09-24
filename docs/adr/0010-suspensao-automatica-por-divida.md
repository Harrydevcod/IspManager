# ADR 0010: Suspensão automática por dívida e reativação por pagamento

## Estado

Aceite e implementado.

## Contexto

O ADR 0007 separou intenção (base de dados) de realidade (MikroTik) e o ADR 0008
implementou a reconciliação PPPoE. Faltava a decisão que liga cobrança a essa
intenção: quando uma fatura ultrapassa a tolerância, o serviço correspondente
deve ser suspenso; quando a dívida que justificou o corte é regularizada, deve
ser reposto.

O risco principal não é deixar um devedor online mais uma hora. É cortar por
engano quem pagou, ou transformar um erro de dados num corte em massa.

## Decisão

- A suspensão automática é desligada por omissão.
- O `routerosDryRun` protege também a cobrança: em ensaio calculam-se candidatos,
  mas `services.status` não muda e o router não recebe qualquer escrita.
- A regra atua por serviço, nunca por cliente inteiro.
- Só entram serviços controlados por PPPoE e faturas com saldo positivo,
  vencidas há mais que `autoSuspensionGraceDays`.
- Qualquer crédito positivo na conta do cliente bloqueia o corte automático e
  manda o caso para revisão.
- Antes de cada corte LIVE, dívida, crédito e estado são revalidados.
- Antes de mudar qualquer serviço para `suspended` em LIVE, o backend faz uma leitura REST real ao MikroTik. Se o router estiver inacessível (LAN/VPN em baixo, timeout, rota ausente, credenciais recusadas), não muda o estado do serviço, regista `auto_suspension_router_unreachable` e deixa o candidato para a passagem seguinte.
- Há duas travas: máximo absoluto por passagem e percentagem máxima da base PPPoE
  ativa. Se qualquer uma dispara, o lote inteiro é abortado.
- `services.suspension_source = 'nonpayment'` distingue o corte automático de
  uma suspensão manual. Linhas antigas com origem nula são tratadas como manuais.
- Um pagamento só reativa automaticamente um serviço suspenso por `nonpayment`
  e quando já não resta dívida fora da tolerância.
- O job corre no arranque e em intervalo configurável, porque a aplicação é
  desktop e pode estar desligada no momento em que a tolerância expira.
- O job muda a intenção; a reconciliação do ADR 0007 continua a ser a única
  camada que escreve o estado PPPoE no MikroTik.

## Fluxo

```
fatura vencida + tolerância expirada
  -> services.status = suspended (origem nonpayment)
  -> reconciliação
  -> PPP secret disabled + sessão terminada

pagamento regulariza dívida
  -> services.status = active
  -> reconciliação
  -> PPP secret enabled
```

Falha do router não é confundida com sucesso: em modo LIVE a suspensão comercial é adiada antes de qualquer mudança de estado se a leitura REST falhar. O cliente mantém acesso, a falha fica auditada e o job periódico tenta novamente. `service_network_state` continua a representar a realidade observada.
