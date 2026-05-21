# Backup automático + Restore — Design Spec

> ISPM desktop (Electron + Fastify + better-sqlite3). Status: **Approved** (design), pending implementation plan.
> Decisão de política do fundador registada abaixo. Relacionado: `docs/adr/0003-versioned-sql-migrations.md`.

## Objetivo

Proteger os dados operacionais de uma operadora ISP contra perda (disco, corrupção, erro humano) com backups consistentes automáticos e um caminho de restauro à prova de falhas — sem comprometer a disponibilidade da aplicação.

## Princípios

- O ficheiro SQLite (`ispm.sqlite`) é a **única fonte de verdade**. PDFs/recibos são regeneráveis a partir dele; não se faz backup deles.
- Backup consistente via `better-sqlite3` `database.backup()` — cópia online, lida com WAL, sem downtime nem locking da app.
- **Disponibilidade > backup**: qualquer falha no backup automático é logada mas **nunca** bloqueia o arranque da aplicação.
- Restauro é destrutivo e idempotente-seguro: valida antes de tocar em nada, guarda rede de segurança do estado atual, e delega o restart ao processo Electron.

## Decisões de política (fixadas pelo fundador)

| Decisão | Escolha |
|---|---|
| Cadência do backup automático | **Só no arranque** — um backup por sessão, quando o backend inicializa. |
| Retenção | **Diário 14 + semanal 8** — manter a entrada mais recente por dia nos últimos 14 dias de calendário; das entradas **mais antigas que essa janela de 14 dias**, manter a mais recente por semana ISO até 8 semanas; podar todo o resto. |
| Restauro | **Restaura + reinicia app** — validar, snapshot do DB atual, trocar ficheiro, relaunch do Electron. |
| Destino | **Pasta local + destino configurável** — default `<dataDir>/backups`; campo nas Definições para apontar a uma pasta externa/cloud-sync (offsite). |

## Arquitetura

### Componentes

**`src/backend/lib/paths.ts`** — extração. A resolução do data dir (`ISPM_DATA_DIR` || `APPDATA`||`homedir` + `'ISPM'`) está hoje inline em `database.ts`; o backup precisa exatamente da mesma. Extrair `resolveDataDir(): string`, consumido por `database.ts` e `backup.ts`. Melhoria pontual justificada por este trabalho (uma única fonte da verdade para o caminho dos dados).

**`src/backend/lib/backup.ts`** — motor, sem dependências HTTP:

- `resolveBackupDir(): string` — lê `app_settings.backupDir`; se definido e for diretório existente e gravável, usa-o; senão fallback `<dataDir>/backups` (criado com `mkdirSync recursive`).
- `createBackup(reason: 'startup' | 'manual'): Promise<BackupEntry>` — destino `ispm-YYYYMMDD-HHmmss.sqlite` em `resolveBackupDir()`, via `db.backup(dest)`. Retorna `{ file, sizeBytes, createdAt }`.
- `listBackups(): BackupEntry[]` — varre o dir, faz parse do timestamp a partir do nome (ignora ficheiros que não casam o padrão), ordena desc, anexa `sizeBytes`.
- `selectForRetention(entries: BackupEntry[], now: Date): BackupEntry[]` — **função pura, sem FS**: devolve a lista de entradas **a apagar**. Mantém a entrada mais recente por dia de calendário nos últimos 14 dias que têm backups; das restantes (mais antigas que a janela diária), mantém a mais recente por semana ISO até 8 semanas; tudo o resto é podado. Snapshots `pre-restore-*` nunca são podados por esta função (categoria à parte).
- `pruneBackups(): void` — aplica `selectForRetention(listBackups(), new Date())` e apaga os ficheiros selecionados.
- `validateBackup(file: string): { ok: boolean; reason?: string }` — abre o candidato read-only; corre `PRAGMA integrity_check` (tem de devolver `ok`) e exige a tabela `schema_migrations` com ≥1 linha (recusa ficheiros corruptos ou pré-migrations). Fecha sempre a ligação.
- `restoreBackup(file: string): { restartRequired: true }` — fluxo:
  1. `validateBackup(file)`; se inválido, lança erro **sem mutar nada**.
  2. Snapshot do DB atual para `<backupDir>/pre-restore-YYYYMMDD-HHmmss.sqlite` (rede de segurança).
  3. `closeDatabase()` — fecha a ligação SQLite viva.
  4. Substitui `<dataDir>/ispm.sqlite` pelo conteúdo do backup; remove `ispm.sqlite-wal` e `ispm.sqlite-shm` órfãos.
  5. Retorna `{ restartRequired: true }`. No relaunch, `getDatabase()` reabre e corre `runMigrations` (idempotente, drift-safe): um backup com schema antigo é **migrado automaticamente para a frente**.

**`src/backend/db/database.ts`** — adicionar `closeDatabase()` de produção (fecha `sqliteInstance`, anula `sqliteInstance` e `database`); `closeDatabaseForTests()` passa a delegar nele. `getDatabase()` usa `resolveDataDir()` de `paths.ts`.

**`src/backend/server.ts`** — em `createBackendApp()`, imediatamente após `getDatabase()`:
```
try { await createBackup('startup'); pruneBackups(); }
catch (e) { app.log?.error(e) /* nunca relança */ }
```

**`src/backend/routes/backup.ts`** — registado em `server.ts`:
- `GET /api/backups` → `{ backupDir, entries: BackupEntry[] }`.
- `POST /api/backups` → `createBackup('manual')` depois `pruneBackups()` → entrada criada.
- `POST /api/backups/restore` body `{ file: string }` → restringe `file` a um nome dentro de `resolveBackupDir()` (sem path traversal) → `restoreBackup` → `{ restartRequired: true }`.
- Chave `backupDir` adicionada às chaves aceites pelas rotas de Definições existentes, com validação (diretório existente e gravável).

**`src/main/index.ts` + `src/main/preload.ts`** — ponte IPC `app:relaunch` que faz `app.relaunch(); app.exit(0)`. O renderer, ao receber `restartRequired` da rota de restore, invoca-a. (O padrão IPC exato — `contextBridge`/`ipcMain.handle` — é confirmado lendo estes ficheiros no planeamento; o design assume o padrão já existente no preload.)

**Renderer (`src/renderer/App.tsx`, secção Definições)** — sub-painel "Backups" (idioma de UI existente, sem nova abstração de modal):
- Lista: data/hora, tamanho legível, por linha "Restaurar".
- Botão "Criar backup agora".
- "Restaurar" exige **confirmação forte** (escrever uma palavra de confirmação, dado ser destrutivo); ao confirmar, chama a rota e, com `restartRequired`, dispara o relaunch IPC.
- Campo "Pasta de backups" (persistido via Definições → `backupDir`).

### Fluxo de dados

```
Arranque:    createBackendApp → getDatabase (migrado) → createBackup('startup') → pruneBackups → rotas
Manual:      UI → POST /api/backups → createBackup('manual') → pruneBackups → lista atualizada
Restore:     UI (confirmação) → POST /api/backups/restore → validate → snapshot pre-restore →
             closeDatabase → swap ficheiro (+limpar -wal/-shm) → {restartRequired} →
             UI → IPC app:relaunch → Electron app.relaunch/exit → reabre → getDatabase → runMigrations
```

### Tratamento de erros

- Backup automático falha (dir não gravável, disco cheio): log de erro, app continua normal.
- `validateBackup` falha no restore: erro 400 ao cliente, **zero mutação** do estado.
- Falha ao trocar o ficheiro depois do snapshot: o `pre-restore-*` permanece como recuperação manual; erro propagado claramente.
- `file` inexistente ou fora do backupDir: 400, rejeitado antes de qualquer ação.

## Testes (TDD, padrão `finance.test.ts`)

- `selectForRetention` (puro): mantém 1/dia em 14 dias; 1/semana ISO em 8 semanas; poda o excedente; ignora `pre-restore-*`; entrada vazia; limites exatos da janela.
- `validateBackup`: DB migrado válido passa; ficheiro corrupto falha; DB sem `schema_migrations` falha.
- `createBackup`: ficheiro resultante abre e contém todas as tabelas baseline + `schema_migrations`.
- `restoreBackup`: ficheiro inválido lança e não muta; válido cria `pre-restore-*` e troca; restaurar backup com schema antigo + re-correr migrations traz para a frente sem perda.
- Rotas via `app.inject()`: `GET` lista, `POST` cria e poda, `restore` rejeita path traversal e devolve `restartRequired`.

## Fora de scope (YAGNI)

Encriptação de backups; upload cloud; backups agendados em runtime (escolha = só-arranque); incrementais/diferenciais; backup de PDFs/recibos (regeneráveis a partir do DB).

## Notas de integração

- Não é um repositório git (`Is a git repository: false`) — o spec não é committed; fica versionado no disco do projeto.
- Compatível com ADR 0003: o restore depende de `runMigrations` ser idempotente e drift-safe para migrar backups antigos para a frente.
