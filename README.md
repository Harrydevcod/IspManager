# ISPM

> ISP Manager desktop — gestão operacional para Provedores de Internet em Cabo Verde.

Aplicação desktop offline-first construída para correr na operação diária de um ISP: clientes, planos, serviços, cobrança, stock de equipamento, OS técnicas, relatórios e auditoria — tudo num único binário que arranca em segundos.

---

## Características

| Módulo | O que faz |
| --- | --- |
| **Dashboard** | Visão operacional consolidada — receita, vencimentos, fila de trabalho, mix de planos |
| **Clientes** | CRUD, importação CSV/Excel com mapeamento automático, histórico técnico |
| **Planos** | Catálogo de planos (rádio / fibra / cabo), tarifário, taxa de instalação |
| **Serviços** | Subscrições activas, atribuição de equipamento, eventos técnicos |
| **Pagamentos** | Cobrança recorrente, controlo de atrasos, geração de recibos |
| **OS técnicas** | Kanban de ordens de serviço (aguarda → agendada → em curso → concluída) |
| **Stock** | Catálogo de equipamento, movimentos, custo aterrado, atribuições |
| **Relatórios** | Receita por mês, clientes em atraso, valor de inventário |
| **Rede** | Sonda ICMP de disponibilidade e controlo de acesso no MikroTik: corte/reposição, aprovisionamento PPPoE e velocidade por plano (ADR 0007 e 0008) |
| **Utilizadores** | Multi-perfil (admin / operadora / técnico), gestão de contas |
| **Auditoria** | Registo imutável de quem fez o quê, quando |
| **Configurações** | Backup/restore, parâmetros do sistema |

---

## Stack

- **Renderer**: React 19 + Vite 7 + TypeScript
- **Main**: Electron 42
- **Backend local**: Fastify 5 (HTTP em `127.0.0.1:3001`)
- **Persistência**: SQLite via `better-sqlite3` + Drizzle ORM, migrações versionadas
- **Auth**: scrypt + HMAC-SHA256 tokens (sem dependências externas)
- **Testes**: Vitest
- **Distribuição**: electron-builder (NSIS no Windows)

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│  Electron main (src/main)                               │
│  ├─ janela BrowserWindow                                │
│  └─ spawn backend Fastify (src/backend/standalone.ts)   │
│                                                         │
│  Renderer React (src/renderer)                          │
│  └─ HTTP → http://127.0.0.1:3001  ───┐                  │
│                                       │                 │
│  Backend Fastify (src/backend)        ◄                 │
│  ├─ /api/auth, /api/clients, /api/services, ...         │
│  ├─ Drizzle + better-sqlite3                            │
│  └─ migrações versionadas (src/backend/db/migrations)   │
│                                                         │
│  SQLite local (userData/ispm.db, modo WAL)              │
└─────────────────────────────────────────────────────────┘
```

Tudo corre na máquina do utilizador. Sem cloud, sem dependências externas em runtime, sem telemetria.

---

## Começar

### Pré-requisitos

- Node.js 20+
- Windows 10/11 (ou Linux/macOS para desenvolvimento)
- Visual Studio Build Tools (Windows) para compilar `better-sqlite3`

### Instalação

```bash
npm install
```

### Modo desenvolvimento

```bash
npm run dev
```

Arranca em paralelo:
- Vite dev server em `:5173`
- Fastify backend em `:3001`
- Janela Electron com hot reload

### Testes

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

### Build de produção

```bash
npm run build     # tsc + vite build + electron-builder
```

O instalador NSIS sai para `release/`.

---

## Autenticação

Modelo de 3 perfis fixos:

| Role | Acesso |
| --- | --- |
| **admin** | Tudo, incluindo gestão de utilizadores e auditoria |
| **operator** | Operação diária (clientes, serviços, pagamentos, relatórios) |
| **technician** | OS técnicas, consulta de clientes e stock |

Primeiro arranque pede setup do admin inicial. Sessões persistem 7 dias via token HMAC assinado.

Para desenvolvimento, definir `ISPM_AUTH=off` faz bypass completo (não usar em produção).

---

## Estrutura do código

```
src/
├── main/              Electron main process
├── backend/
│   ├── db/            Drizzle schema + migrações versionadas
│   ├── lib/           auth, audit, backup, billing, numbering
│   └── routes/        endpoints REST (Fastify)
└── renderer/
    ├── components/    primitivos partilhados (Card, Field, Dialog, ...)
    ├── lib/           auth context, format, status
    ├── modules/       um ficheiro por módulo do ERP
    ├── App.tsx        shell + router
    ├── styles.css     design tokens + componentes
    └── types.ts       contratos partilhados
```

---

## Convenções

- Documentos fiscais nunca são apagados — apenas anulados.
- Numeração sequencial sem gaps.
- Migrações monotónicas (`NNNN_name.ts`), nunca editadas após shipped.
- Backups WAL→DELETE normalizados.

---

## Licença

Proprietário. Todos os direitos reservados.
