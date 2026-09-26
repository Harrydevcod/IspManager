# ADR 0012: Cofre de credenciais com chave de recuperação

## Estado

Aceite e implementado (2.6). Substitui a parte de selagem do ADR 0009.

## Contexto

O ADR 0009 selou as credenciais com o DPAPI da conta do Windows. Isso deixou três problemas:

1. **Restaurar um backup noutra máquina destruía as credenciais.** O arranque não conseguia abrir o bloco
   selado e apagava-o. A 2.4 parou de apagar, mas a credencial continuava ilegível sem a máquina original.
2. **A senha PPPoE dos clientes ficava em claro** na coluna `services.pppoe_password`, e a API devolvia-a.
3. **As Definições devolviam uma máscara** que o servidor comparava com a senha para decidir se a
   mantinha. Era um protocolo frágil, e cada consumidor tinha de conhecer a convenção.

## Decisão

Todas as credenciais persistidas passam por um **cofre**: uma chave de dados aleatória de 32 bytes que
cifra cada valor com AES-256-GCM. O formato gravado é `enc:v2:<nonce>:<tag>:<ciphertext>`, e o AAD é
`v2|tabela.coluna`, por exemplo `services.pppoe_password` ou `app_settings.routerosPassword`. O AAD separa
domínios: um valor das Definições não abre como senha PPPoE. Não se prende à linha (decisão D2 do plano).

A chave de dados é guardada **duas vezes**, na tabela `credential_vault` (migração 0064):

- **selada pela máquina** (DPAPI via `safeStorage`), para o arranque normal não pedir nada;
- **selada pela chave de recuperação**, mostrada uma única vez ao administrador, que tem de a
  reintroduzir para confirmar que a guardou.

Os estados do cofre são `ready`, `recovery_pending` (criado, chave ainda por confirmar), `locked` (a
máquina não abre a chave de dados) e `absent` (não há proteção local e o cofre nunca foi criado).

Toda a leitura e escrita passa por `src/backend/lib/secrets.ts`. A API **nunca devolve uma credencial**:
responde com `…Configured` (`pppoePasswordConfigured`, `routerosPasswordConfigured`,
`ultraMsgTokenConfigured`). No protocolo de escrita, uma propriedade omitida quer dizer manter e uma
string não vazia quer dizer substituir. A interface mostra "Configurada" e só abre um campo vazio ao
carregar em "Editar" (`SecretField`).

### O que isto protege, e o que não protege

| Cenário | Antes (ADR 0009) | Agora |
| --- | --- | --- |
| `ispm.sqlite` ou backup copiado, sem a chave de recuperação | segredos das Definições ilegíveis, **senhas PPPoE em claro** | nenhuma credencial legível |
| Restauro legítimo noutra máquina | credenciais perdidas (até à 2.3 apagadas) | cofre `locked`; a chave de recuperação desbloqueia e nada se perde |
| A API a devolver credenciais | senha PPPoE para admin e operador; máscara nas Definições | nenhuma, em nenhum papel |
| Código malicioso a correr **como este utilizador** | exposto | exposto na mesma |
| Chave de recuperação guardada ao lado do backup | não se aplica | quem tiver os dois tem as credenciais |

As duas últimas linhas são as honestas. O DPAPI decifra para qualquer processo do utilizador, e a chave
de recuperação vale o que valer o sítio onde for guardada. O ganho real é outro: a coluna
`pppoe_password` deixa de estar em claro, e um `ispm.sqlite` copiado deixa de dar credenciais, **sem
perder o parque num restauro legítimo**.

## Consequências

**Ordem de arranque:** migrações → segredo das sessões (local, nunca portátil) → abrir o cofre →
converter as credenciais antigas (`enc:v1:` e texto simples) → backup de arranque → jobs → escuta. O
backup só corre depois da conversão, para não copiar credenciais antigas em claro. Se uma credencial não
converte (por exemplo um `enc:v1:` de outra conta do Windows), a API comercial continua de pé, e ficam
parados as integrações e os backups normais até um administrador resolver.

**Cofre trancado não é uma avaria (D4).** O login, a licença, a faturação e os relatórios funcionam. Só
param as integrações (RouterOS, UltraMsg, SMS) e os backups normais. O administrador vê um aviso em
todos os módulos e desbloqueia em Configurações → Cofre com a chave de recuperação. A migração corre a
seguir ao desbloqueio, sem reiniciar.

**Em `npm run dev` o cofre fica `locked` ou `absent` (D3).** Fora do Electron não há `safeStorage`, e o
cofre **nunca é criado** sem proteção local: um cofre criado assim ficaria ilegível para a app empacotada.
O desenvolvimento contra a base real funciona com as integrações desligadas.

**Um `enc:v1:` que não abre** (selado por outra máquina ou conta, antes do cofre) só se resolve na
máquina original ou escrevendo essa credencial de novo. Nunca é apagado (D5).

**A primeira versão com o cofre tem de arrancar uma vez na máquina original**, para converter os valores
`enc:v1:` antes de qualquer restauro noutro sítio.

**Senhas PPPoE geradas automaticamente não voltam a ser mostradas.** Para as dar a um técnico, o
administrador escreve a senha ao criar o serviço, ou muda-a com a ação dedicada "Alterar senha PPPoE"
(auditada). Uma entrega ao cliente com um fluxo próprio fica para quando fizer falta.

**Depois de um restauro** a base é trocada, o cofre é descartado (`dispose`) e a API responde apenas
que é preciso reiniciar. Nenhum temporizador reabre a base.

**Fica de fora, de propósito:** a rotação da chave de recuperação (seria uma máquina de estados para algo
usado zero vezes), o `serviceId` no AAD, e cifrar a base inteira. Uma chave guardada ao lado do ficheiro
que protege não protege nada; ver ADR 0009.
