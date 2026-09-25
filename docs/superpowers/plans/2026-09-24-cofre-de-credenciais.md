# Cofre de credenciais — plano de implementação

> Revisão do plano de 2026-09-24, com os cortes listados abaixo. **Spec:** `docs/superpowers/specs/2026-09-24-cofre-de-credenciais-e-campos-protegidos-design.md`.
>
> **Stack:** Electron 41, Node crypto, Fastify 5, better-sqlite3, React 19, TypeScript, Vitest.

## Context

Três problemas reais, por ordem de gravidade:

1. **Perda de dados, hoje, em produção.** `sealPendingSecrets` (`src/backend/lib/secrets.ts`, chamado em `src/backend/server.ts:80`) faz `saveSetting(db, key, '')` quando há cifra disponível e o bloco não abre. Restaurar um backup noutra máquina **apaga** a senha do router e o token UltraMsg — irreversivelmente, e sem hipótese de voltar à máquina original.
2. **Senha PPPoE em claro na base e na API.** A coluna `services.pppoe_password` não está cifrada (ADR 0009 deixou-a de fora de propósito) e `src/backend/routes/finance.ts:97,127` devolve-a em claro a admin **e** operador; `ServicesModule.tsx:232` pré-preenche o formulário de edição com ela.
3. **Sentinela `SECRET_MASK`** (`routes/settings.ts:149`) como protocolo: gravar as Definições devolve a máscara e o servidor compara strings para decidir se preserva a credencial. Frágil, e obriga cada consumidor a conhecer a convenção.

O objetivo desta mudança é cifrar as credenciais persistidas com uma chave que **não** viaja com o ficheiro, tirar os segredos das respostas da API, e permitir recuperar o cofre noutra máquina com uma chave que o administrador guarda.

**O que isto não é:** proteção contra código malicioso a correr como o mesmo utilizador (o DPAPI decifra para ele tal como decifra para nós), nem contra quem guarde a chave de recuperação ao lado do backup. O ganho real e defensável é: **a coluna `pppoe_password` deixa de estar em claro e um `ispm.sqlite` copiado deixa de dar credencial nenhuma** — sem perder o parque num restauro legítimo. É isto que o ADR deve dizer, nem mais.

## Cortes face ao plano original

| Cortado | Porquê |
|---|---|
| Mover o backend para dentro do Electron em dev (T5 original) | Mata o `tsx watch`: cada alteração de backend passaria a exigir reinício do Electron, todos os dias. Resolvido em vez disso por: **em standalone o cofre nunca é criado, só aberto** — ver Decisão D3. |
| `operation-lifecycle.ts` / quiescência de restauro (T6 original) | Se restaurar com jobs a correr parte, parte hoje, independentemente do cofre. É um bug próprio, com fix próprio. Fica `vault.dispose()` + `requiresRestart`. |
| Rotação da chave de recuperação (T2/T7 original) | Candidato selado, confirmação pendente, crash a meio, confirmações concorrentes — máquina de estados para algo que será usado zero vezes. YAGNI. |
| `serviceId` no AAD (T4 original) | Quem escreve na base para trocar ciphertexts entre linhas já podia escrever a senha que quisesse. Custava um caminho de decifrar/recifrar nas transferências e não comprava nada. Ver D2. |
| QR SMS no âmbito do cofre (T7 original) | O pareamento SMS já funciona; misturá-lo aqui alarga a superfície sem necessidade. |
| Passar todos os campos de password da app para `SecretField` (T7 original, ~14 ficheiros) | Só os campos que mostram **segredos persistidos** entram. Login/setup/reset/licença são inputs de uso único que nunca revelam nada guardado. |

## Decisões

- **D1 — sem rotação.** Chave de recuperação gerada uma vez, mostrada uma vez, confirmada uma vez. Guardada em `recovery_wrapped_key`, geração fixa em 1.
- **D2 — AAD = `tabela.coluna`**, não a linha. Contextos: `services.pppoe_password`, `app_settings.routerosPassword`, etc. O AAD separa domínios (um ciphertext de settings não abre como PPPoE); não tenta atar-se à linha.
- **D3 — o cofre só nasce sob Electron.** `openVault` com uma `LocalProtection` indisponível **abre** o que existir (não consegue: fica `locked`) mas **nunca cria**. Consequência: `npm run dev` contra a base real fica com o cofre `locked` — integrações desligadas, tudo o resto normal — e nunca envenena a base com um cofre que a app empacotada não sabe abrir. Os testes injetam a sua própria `LocalProtection`. O comando `dev` não muda.
- **D4 — `locked` é um estado de primeira classe**, não um erro de arranque. Login, licença, faturação e relatórios funcionam com o cofre trancado. Só integrações (RouterOS, UltraMsg, SMS) e backups normais é que param.
- **D5 — nunca apagar um segredo por não o conseguir abrir.** Substitui o comportamento atual. Marca-se como indisponível; o valor fica.

## Restrições globais (mantidas do original)

- DRY RUN RouterOS ligado; suspensão automática LIVE desligada.
- Passwords de utilizadores continuam hashes `scrypt`, fora do cofre.
- Nenhuma credencial regenerada automaticamente. Uma escrita de segredo nunca cai para texto simples.
- Bases temporárias nos testes; não migrar nem restaurar a base real.
- Trabalhar em worktree isolada — o `npm run dev` do utilizador aplica migrações à base real assim que as vê.
- Não editar migrações aplicadas. Próximo número livre: **0064**.
- Sem chamadas reais a MikroTik, UltraMsg ou SMS nos testes.

## Plano de lançamento

A partir da 2.0 não há versões de correção (ver cabeçalho do `CHANGELOG.md`): um problema urgente sai como a minor seguinte.

- **2.4 (feito):** só a Tarefa 1. O bug de perda de credenciais não fica em produção à espera do cofre.
- **2.5:** Tarefas 2–4 (cofre, migração, APIs sem revelação).
- **2.6:** Tarefas 5–6 (recuperação portátil + UI). Só aqui é que a chave de recuperação chega ao administrador — até lá, um restauro noutra máquina deixa o cofre `locked` sem saída, e a nota de lançamento da 2.5 tem de dizer isso por palavras simples.

---

# Fatia 1 — o que sai primeiro

## Tarefa 1 — Parar de destruir credenciais · **feito, lançado na 2.4**

**Modificar:** `src/backend/lib/secrets.ts`, `secrets.test.ts`, `src/backend/routes/settings.ts`.

Independente de todo o resto e lançável sozinho.

- [x] Teste: bloco selado por outra conta, com cifra disponível → `sealPendingSecrets` devolve a etiqueta **e o valor gravado mantém-se byte a byte**.
- [x] Remover o `saveSetting(db, key, '')` do ramo "selado, cifra a funcionar, não abre". Manter `SECRETS_LOST_KEY` como aviso.
- [x] `clearSecretsLost` deixa de correr no PUT de Definições quando o segredo continua por reescrever — só limpa a etiqueta de uma chave quando essa chave foi efetivamente regravada.
- [x] Correr `npx.cmd vitest run src/backend/lib/secrets.test.ts src/backend/routes/settings.test.ts`; commit.
- [x] Lançar 2.4: bump do `package.json`, entrada no `CHANGELOG.md`, build do instalador Windows, **criar a release antes da tag** e anexar os assets na criação.

## Tarefa 2 — Primitivas e estado do cofre · **feito**

**Criar:** `src/backend/lib/vault-crypto.ts` (+teste), `local-protection.ts` (+teste), `vault.ts` (+teste), migração `0064_credential_vault.ts`.
**Modificar:** `src/backend/db/migrations/index.ts`, `src/backend/db/schema.ts`.

```ts
// vault-crypto.ts — sem SQLite, sem Electron
export function encryptValue(key: Buffer, context: string, value: string): string;
export function decryptValue(key: Buffer, context: string, stored: string): string;

// local-protection.ts
export interface LocalProtection { available(): boolean; seal(v: string): string; open(s: string): string; }

// vault.ts
export type VaultStatus = 'ready' | 'recovery_pending' | 'locked' | 'absent';
export interface Vault {
  status(): VaultStatus;
  encrypt(context: string, value: string): string;
  decrypt(context: string, stored: string): string;
  pendingRecoveryKey(): string;
  confirmRecovery(key: string): void;
  unlock(key: string): void;
  dispose(): void;
}
export function openVault(db: Database.Database, protection: LocalProtection): Vault;
```

- [x] Testes RED: round-trip; dois `encryptValue` do mesmo valor diferem (nonce); contexto errado lança; tag corrompida lança; envelope > 16 KiB rejeitado; encoding não canónico rejeitado.
- [x] Testes RED do cofre com duas `LocalProtection` incompatíveis (máquinas A e B): criar em A, guardar segredo, copiar DB, abrir em B → `locked`; chave errada não altera wrappers; chave certa devolve o valor exato; `dispose()` impede uso posterior; **`openVault` sem proteção disponível devolve `absent` e não escreve nada** (D3).
- [x] Formato `enc:v2:<nonce-b64url>:<tag-b64url>:<ct-b64url>`; chave 32 B, nonce 12 B, tag 16 B; AAD UTF-8 = `v2|<contexto>`. Validar tamanhos, encoding e versão **antes** de decifrar.
- [x] `LocalProtection`: `available()` exige Electron pronto, `isEncryptionAvailable()` e backend ≠ `basic_text`. `seal`/`open` lançam erro tipado que nunca inclui o conteúdo.
- [x] Migração 0064: tabela singleton `credential_vault` (`vault_id`, `format_version`, `local_wrapped_key`, `recovery_wrapped_key`, `pending_recovery_local`, `recovery_confirmed_at`). Só a tabela; não converte dados.
- [x] Criação da chave de dados e dos dois wrappers **numa transação**, persistindo só depois de verificar que ambos reabrem. Nunca recriar em silêncio quando já existe ciphertext sem metadados.
- [x] Verde; commit.

## Tarefa 3 — Migração dos valores legados e sessão independente

**Criar:** `src/backend/lib/vault-migration.ts` (+teste), `session-secret.ts` (+teste).
**Modificar:** `secrets.ts`, `secrets.test.ts`, `src/backend/lib/auth.ts`.

- [ ] Testes RED: valores em texto simples, `enc:v1:` que abre, `enc:v1:` que não abre, prefixo `enc:` desconhecido. **Uma linha inválida preserva todas as outras e aborta a transação.** Reexecução após sucesso é idempotente.
- [ ] `migrateCredentials(db, vault, protection)`: numa transação síncrona, para cada chave de `SECRET_KEYS` e para cada `services.pppoe_password` não vazio — abrir o legado, cifrar com o AAD novo, decifrar e **comparar antes de gravar**. Não tocar em `pppoe_password_sync_pending`, estados de serviço ou configuração de jobs.
- [ ] Preservar bytes: remover o `.trim()` dos caminhos de segredo (`readSecret`/`writeSecret`) sem reescrever passwords existentes.
- [ ] `auth_secret` sai da lista portátil → `session-secret.ts`, selado só localmente. Num restauro recria-se a assinatura (todos entram outra vez); os hashes `scrypt` continuam a validar. Sem proteção local, falhar explicitamente — nunca gravar assinatura em claro.
- [ ] `readSecret`/`writeSecret` mantêm o nome mas passam pelo cofre e lançam quando ele está `locked`/`absent`. Erros expõem código/campo/id, nunca conteúdo. Rever todos os consumidores para não contactarem transportes externos quando o segredo está indisponível.
- [ ] Verde; inspecionar a DB temporária a olho; commit.

## Tarefa 4 — APIs sem revelação

**Modificar:** `src/backend/lib/services.ts`, `serviceTransfer.ts`, `network-enforcement.ts`; `src/backend/routes/finance.ts`, `settings.ts`, `network.ts` e os testes `services.credentials.test.ts`, `settings.test.ts`, `network.test.ts`, `serviceTransfer.test.ts`, `network-enforcement.test.ts`.

Fachada nova em `secrets.ts`: `writePppoeSecret(db, serviceId, plain)`, `readPppoeSecret(db, serviceId)`.
Respostas passam a `pppoePasswordConfigured`, `routerosPasswordConfigured`, `ultraMsgTokenConfigured`. `SECRET_MASK` desaparece.

- [ ] Testes RED: GET de serviços nos três papéis → `expect(row).not.toHaveProperty('pppoePassword')`. Editar só o preço preserva o ciphertext. Gravar Definições sem propriedades secretas preserva credenciais e flags.
- [ ] `finance.ts:97` deixa de selecionar a coluna; calcula presença (`s.pppoe_password <> '' AS pppoePasswordConfigured`). O `.map()` de omissão em `finance.ts:127` deixa de ser preciso.
- [ ] Protocolo de escrita: **propriedade omitida = manter**; string não vazia = substituir; `null` explícito = remover onde é permitido. PPPoE com username não aceita remoção involuntária. Limites 8–64 só para passwords novas.
- [ ] Criação, alteração e transferência de serviços passam pela fachada (`services.ts:181,322,384`; `serviceTransfer.ts:148`). Com o AAD em `tabela.coluna` (D2) a transferência **não** precisa de recifrar.
- [ ] `network-enforcement.ts:94`: o planeamento recebe só presença/pending; `applyAction` chama `readPppoeSecret` apenas para criar/alterar password. Dry-run não precisa do plaintext. Verificar o cofre antes de qualquer transporte.
- [ ] Testar com um segredo-marcador que ele não aparece em respostas, logs nem auditoria. Verde; commit.

---

# Fatia 2 — recuperação e UI

## Tarefa 5 — Rotas do cofre, arranque e campos trancados

**Criar:** `src/backend/routes/vault.ts` (+teste), `src/backend/lib/vault-startup.test.ts`, `src/renderer/components/SecretField.tsx` (+teste), `src/renderer/modules/settings/VaultPanel.tsx` (+teste).
**Modificar:** `src/backend/server.ts`, `standalone.ts`, `src/main/index.ts`, `src/renderer/components/index.ts`, `types.ts`, `settings/NetworkTab.tsx`, `settings/WhatsappTab.tsx`, `settings/SmsTab.tsx`, `ServicesModule.tsx`, `services/ServiceDetailDialog.tsx`.

**Contrato HTTP** (admin-only, `Cache-Control: no-store`):
`GET /api/vault/status` → estado, sem chaves · `POST /api/vault/recovery-key` → só a chave pendente, exige password atual · `POST /api/vault/confirm` ← `recoveryKey` · `POST /api/vault/unlock` ← `recoveryKey`.

```ts
type SecretDraft = { editing: false } | { editing: true; value: string };
type SecretFieldProps = { label: string; configured: boolean; draft: SecretDraft; onDraftChange(next: SecretDraft): void; disabled?: boolean };
```

- [ ] Testes RED: acesso por papel (admin/operador/técnico), chave errada, repetição depois de confirmada, limite de tentativas; o logger nunca mostra o body da recuperação.
- [ ] Arranque em `server.ts`: migrations → sessão local → cofre + migração de credenciais → backup → jobs → escuta. Migração falhada mantém a API comercial de pé com erro administrativo, bloqueando integrações e backups normais (D4). Injetar `LocalProtection` explicitamente em `createBackendApp` para os testes; detetar Electron em produção.
- [ ] `standalone.ts` mantém-se (D3): abre o cofre se conseguir, nunca o cria, e o comando `dev` não muda. Sem canal HTTP de desencriptação; `safeStorage` nunca chega ao renderer.
- [ ] `SecretField`: configurado não tem input; "Editar" produz input vazio e foca-o; olho com `aria-pressed` alterna só aquele input; "Cancelar" remove input e draft; nova renderização depois de gravar volta a trancar. Botões `type="button"`, nunca aninhados no `<label>`.
- [ ] Ligar às flags `…Configured`. Payload leva a propriedade secreta **só** quando há draft editado não vazio. Em `ServicesModule.tsx:232` remover o pré-preenchimento com a password antiga; alterar PPPoE passa a ser ação dedicada.
- [ ] `VaultPanel`: estado, entrega pendente e formulário de desbloqueio. Chave mostrada só na entrega autenticada, nunca carregada ao montar, nunca em `localStorage`/`sessionStorage`; confirmação exige reintroduzir. Explicar que backups antigos continuam a precisar da chave da sua geração.
- [ ] Restauro: `vault.dispose()` + `requiresRestart()` — depois da troca do ficheiro a API só informa que é preciso reiniciar; nenhum timer reabre a DB. Sem máquina de drenagem (cortada).
- [ ] Verde; commit.

## Tarefa 6 — Verificação integrada e documentação

**Criar:** `src/backend/routes/vault.integration.test.ts`, `docs/adr/0011-cofre-de-credenciais.md`.
**Modificar:** ADR 0008 (tirar a afirmação de password visível), ADR 0009 (tirar o fallback em claro), a especificação aprovada, `CHANGELOG.md`.

- [ ] E2E com DB temporária: legado → migração → edição → backup → "máquina B" → login → `locked` → recuperação → transporte RouterOS falso recebe o valor original, e a API nunca o recebe. Snapshot das flags antes/depois idêntico.
- [ ] `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`, `npx.cmd tsc -p tsconfig.main.json --noEmit`.
- [ ] Verificar no Electron real com dados artificiais: criar/editar/cancelar, olho, relock, reinício, entrega pendente interrompida. Sem segredos reais em screenshots; sem router real.
- [ ] Documentar: o que o cofre protege e o que não protege (ver **Context**); porque é que o cofre fica `locked` em `npm run dev`; que um `enc:v1:` que não abra exige a máquina original ou substituição explícita dessa credencial.
- [ ] Nota de lançamento: **esta versão tem de arrancar uma vez na máquina original** para converter os valores legados antes de qualquer restauro noutro sítio. O administrador tem de guardar a chave de recuperação.

---

# Fatia 3 — adiado até fazer falta

- Rotação da chave de recuperação.
- Quiescência de operações no restauro (`operation-lifecycle.ts`) — tratar como bug próprio, se se manifestar.
- Backend dentro do Electron em desenvolvimento.

# Verificação

| Camada | Como |
|---|---|
| Unidade | `npx.cmd vitest run src/backend/lib/vault-crypto.test.ts src/backend/lib/vault.test.ts src/backend/lib/vault-migration.test.ts` |
| Fronteira da API | `npx.cmd vitest run src/backend/routes/services.credentials.test.ts src/backend/routes/settings.test.ts src/backend/routes/vault.test.ts` |
| Regressão completa | `npm.cmd test` + `npm.cmd run typecheck` + `npm.cmd run lint` |
| Base real (só leitura) | `sqlite3 "file:...ispm.sqlite?mode=ro"` — confirmar que `services.pppoe_password` começa por `enc:v2:` em todas as linhas não vazias |
| Manual | Electron empacotado: editar uma senha, gravar outra definição, confirmar que a senha sobrevive; copiar a DB para outra pasta com `ISPM_DATA_DIR` e confirmar `locked` + desbloqueio pela chave |

# Cobertura da especificação

| Requisito | Tarefas |
|---|---|
| AES-GCM, AAD, fail-closed, fornecedor local | 2, 3 |
| Nunca destruir credenciais | 1, 3 |
| Recuperação portátil e confirmação | 2, 5 |
| `scrypt` e login independentes do cofre | 3, 5 |
| APIs sem passwords nem máscaras | 4 |
| Criação/edição/transferência/reconciliação PPPoE | 4 |
| Migração antes dos backups | 3, 5 |
| UI trancada, olho e limpeza de draft | 5 |
| DRY RUN, suspensão automática, auditoria | 4–6 |
| ADRs e aceitação integrada | 6 |
| Rotação, quiescência, dev em Electron | adiados (fatia 3) |
