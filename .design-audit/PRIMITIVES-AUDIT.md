# ISPM — Design System & Primitives Audit

**Data:** 2026-05-23
**Escopo:** `src/renderer/styles.css` (6089L), `src/renderer/components/*` (24 ficheiros), consumo pelos módulos.
**Barra:** Apple / Airbnb / Linear / Stripe / Vercel. Não onde o software está, onde ele está indo.

---

## Veredito global

**Reprova.** Os fundamentos são world-class (tokens OKLCH, Inter Variable disciplinado, a11y real, Dialog primitive sofisticado). O fracasso é de adoção: o design system foi escrito mas não foi consumido. O resultado é uma fachada polida com improvisos por baixo.

A barra de craft está lá. A barra de execução não está.

---

## O que passa

| Área | Por que atende |
|---|---|
| **Tokens** | OKLCH (hue 72 warm), 1518 `var(--*)` refs, 1 único hex em 6089L. Heritage gold como `--accent`. Dark-first declarado, light theme genuíno (não inversão). Restraint real. |
| **Tipografia** | Inter Variable single family com weight + tracking contrast (`--tracking-tight`, `--tracking-tighter`). `font-variant-numeric: tabular-nums` em toda coluna de dinheiro. Feature settings `cv11, ss01, ss03, calt, kern`. Editorial, não default. |
| **Motion** | Easing curve `cubic-bezier(0.16, 1, 0.3, 1)` (Apple/Linear spring-out). 3-tier duration (`--motion-fast/base/slow`). 10 keyframes nomeados, intencionais. |
| **Acessibilidade** | Focus-visible em todos os interativos. Skip-link. `prefers-contrast`, `prefers-reduced-motion`, `forced-colors`. 44×44 touch targets em coarse pointers. Não é teatro — é construído. |
| **Dialog primitive** | Portal, focus trap, restore focus, body scroll lock, **`onCloseRef` para evitar re-focus snap em parent re-renders** (detalhe que 99% das implementações erra). |
| **TypeScript** | `strict: true` em ambos tsconfigs. |

---

## Reprovações (priorizadas por impacto)

### 🔴 P0 — Primitives mortos (adoção zero)

**Achado:** `Button`, `Field`, `Select`, `EmptyState`, `Toolbar` têm **0 imports** em qualquer módulo. Toaster idem (só o `useToast` é consumido).

Em vez disso, os módulos usam diretamente:
- **129** `<button>` bare
- **96** `<input>` bare
- **35** `<select>` bare

**Por que reprova:** Princípio de Diferenciação. O design system existe pra garantir que "tudo se sente junto". Se cada módulo improvisa, a barra "trocar o logo e poderia ser qualquer coisa" começa a aparecer. Stripe/Linear/Vercel têm primitives consumidos universalmente — é isso que cria identidade.

**Como corrigir:**
1. **Decidir agora:** primitives são canónicos ou são deletados? Estado órfão é o pior dos mundos.
2. Se canónicos (recomendado): plano de migração por módulo (waves de 1 módulo/PR). Antes de migrar, expandir API:
   ```ts
   <Button variant="primary|secondary|ghost|danger|icon" size="sm|md|lg">
   <Field label error hint required leadingIcon trailingSlot>
   <Select label error options={[]}> // ou children
   ```
3. Adicionar lint rule (`no-restricted-syntax` em ESLint) bloqueando `<button>` bare em `src/renderer/modules/**`.

---

### 🔴 P0 — `Toolbar` === `FilterBar` (literalmente)

**Achado:** `Toolbar.tsx` (10L) e `FilterBar.tsx` (15L) renderam o mesmíssimo `<div className="filter-bar">{children}</div>`. O comentário do `FilterBar` admite: *"structurally identical to Toolbar"*. Toolbar tem **0 callers**.

**Por que reprova:** Sofisticação. Todo elemento tem que ter razão pra existir. Dois componentes idênticos = um deles é decoração.

**Como corrigir:** Deletar `Toolbar.tsx` + remover export do `index.ts`. Zero impacto (0 callers).

---

### 🔴 P0 — `DetailModal` mente sobre o que é

**Achado:** O próprio JSDoc admite: *"Inline detail panel… NOT a backdrop modal — the `DetailModal` name is retained per the plan/Task 6 contract."*

**Por que reprova:** Usabilidade cognitiva. Nomes que mentem custam tempo de outros developers. Eles vão assumir focus trap, ESC handler, scroll lock — e não tem. O contrato Task 6 foi planning, não fiscal — naming pode mudar.

**Como corrigir:** Renomear → `DetailPanel`. Atualizar `index.ts` + 1 caller (`PaymentsModule.tsx`). Atualizar memory note `ispm-design-system.md`.

---

### 🟠 P1 — Sem scale para `z-index` e breakpoints

**z-index encontrados:** `1, 4, 40, 100, 105, 110, 200, 1000` — random.

**Breakpoints encontrados (11 diferentes):** `520, 560, 600, 640, 720, 760, 960, 980, 1100, 1120, 1280`. Random.

**Por que reprova:** Sofisticação + escala. Sem tokens, ordens visuais quebram silenciosamente (Dialog atrás de Toast? Palette atrás de Dialog?). Sem breakpoint scale, responsivo é roleta russa.

**Como corrigir:** Adicionar em `:root`:
```css
/* layer order */
--z-base: 1;
--z-dropdown: 40;
--z-sticky: 100;
--z-toast: 200;
--z-dialog: 1000;
--z-palette: 1100;

/* breakpoint scale */
--bp-sm: 640px;
--bp-md: 960px;
--bp-lg: 1280px;
```
Migrar todos os `z-index: N` literais → `var(--z-*)`. Consolidar os 11 breakpoints para 3 (sm/md/lg). Os intermediários (520, 600, 720, 760, 980, 1100, 1120) são lixo acumulado de decisões locais.

---

### 🟠 P1 — Section L1750: "Other modules — refined next pass"

**Achado:** Comentário literal no `styles.css` admite trabalho inacabado para módulos não-slice (Audit, Backups, Reports, Users, WorkOrders, Plans, Stock, Services, Investments, Expenses — quase todos).

**Por que reprova:** Rejeição imediata da skill — "energia de a gente faz bonito depois".

**Como corrigir:** Fazer o pass. Trazer cada módulo pro padrão da slice polida (Payments + Dashboard). Eliminar a seção. Este é o maior bloco de trabalho do refactor — provavelmente 1 phase do gsd-roadmap.

---

### 🟠 P1 — CSS monolítico (6089L num arquivo, ~80% module-specific)

**Achado:** Top namespaces no global CSS são module-specific:
- `investment-*` 31 classes
- `import-*` 29 classes
- `expense-*` / `kanban-*` 20 cada
- `combobox-*` 16
- `payment-*` 12, `auth-*` 12, `user-*` 12

**Por que reprova:** Estrutura. Design system real distingue tokens / primitives / module styles. Aqui tudo vive junto, custo cognitivo alto, divergência silenciosa garantida.

**Como corrigir (escolher 1):**
- **(a) CSS Modules** — mover classes module-specific para `ModuleName.module.css` adjacente. `styles.css` fica com tokens + base + shell + primitives (~1500L). Alinha com Vercel/Stripe.
- **(b) Particionar monolito** — `tokens.css`, `base.css`, `shell.css`, `primitives.css`, `modules.css` importados em sequência. Refactor menor, ganho menor.

Recomendo **(a)**.

---

### 🟡 P2 — `ThemeToggle` hardcoda `#F6F3EC` e `#16130F`

**Achado:** `ThemeToggle.tsx:14`:
```ts
document.documentElement.style.background = next === 'light' ? '#F6F3EC' : '#16130F';
```
Esses são os **únicos** hex literais em todo o renderer.

**Por que reprova:** Fura o sistema de tokens. `:root[data-theme="light"]` já redefine `--bg`; o `<html>` deveria ler `var(--bg)`, não inline style JS.

**Como corrigir:** Deletar a linha 14 de `ThemeToggle.tsx`. Adicionar em `styles.css`:
```css
html { background: var(--bg); }
```

---

### 🟡 P2 — `#34d399` solto no CSS (1 hex em 6089L)

**Achado:** Único hex literal sobrevivente. Verde de migração antiga.

**Como corrigir:** Identificar contexto (provável: success indicator) e substituir por `var(--success)` ou variante OKLCH derivada.

---

### 🟡 P2 — 13 `!important`

**Achado:** Modesto mas >0. Cada um é uma admissão de cascata mal planeada.

**Como corrigir:** Auditar todos. Para cada, achar a regra concorrente e reescrever com especificidade igual/maior sem `!important`.

---

### 🟡 P2 — `ClientImportDialog` é 577L num "component"

**Achado:** Outlier monstruoso. Próximo componente é Combobox 232L. Tem parsing + mapping + validation + UI misturados.

**Por que reprova:** Estrutura. Isso não é primitive — é feature.

**Como corrigir:** Extrair para `src/renderer/modules/clients/import/`:
- `ClientImportDialog.tsx` orquestrador (~150L)
- `useClientImport.ts` state machine + parsing (~200L)
- `ImportPreviewTable.tsx` (~100L)
- `ImportColumnMapper.tsx` (~100L)

---

### 🟢 P3 — `EmptyState` reusa `module-message` (não é estado vazio dedicado)

**Achado:** O `EmptyState` renderiza `<p className="module-message">` — mesma classe da mensagem de erro/status. Sem ícone, sem ação proeminente, sem ilustração.

**Por que reprova:** Princípio de Encantamento. Estado vazio é uma das oportunidades de design mais subestimadas. Linear, Notion, Stripe — todos investem em empty states que ensinam, encantam, ou guiam o próximo passo.

**Como corrigir:** Redesenhar `EmptyState` com slot para `icon`, `title`, `description`, `action`. Adicionar classe dedicada `.empty-state` com whitespace generoso e tipografia próxima ao `Card.eyebrow`. Não copiar o `module-message`.

---

### 🟢 P3 — `Combobox` é "EntityCombobox" disfarçado

**Achado:** API força `rowCode + rowLabel + rowHint` — modelo "código → nome" específico do ISPM. Funciona, mas o nome promete mais.

**Como corrigir (opcional):** Renomear → `EntityCombobox`, ou aceitar o atual e adicionar JSDoc declarando explicitamente que é o padrão CNNNN/PLN-NNN da app.

---

## Tabela de prioridades

| # | Item | Impacto | Esforço |
|---|---|---|---|
| 1 | Adoção de primitives (Button/Field/Select) | 🔴 Alto | M-L (migração por módulo) |
| 2 | Deletar `Toolbar` (dup de FilterBar) | 🔴 Alto | XS |
| 3 | Renomear `DetailModal` → `DetailPanel` | 🔴 Alto | XS |
| 4 | Tokens de z-index + breakpoints | 🟠 Médio | S |
| 5 | Pass nos módulos "non-slice" (L1750) | 🟠 Médio | L |
| 6 | CSS Modules para classes module-specific | 🟠 Médio | M |
| 7 | Fix ThemeToggle hex hardcoded | 🟡 Médio | XS |
| 8 | Eliminar `#34d399` e os 13 `!important` | 🟡 Baixo | S |
| 9 | Quebrar `ClientImportDialog` (577L) | 🟡 Baixo | M |
| 10 | Redesenhar `EmptyState` | 🟢 Baixo | S |
| 11 | Renomear Combobox → EntityCombobox | 🟢 Baixo | XS |

---

## Recomendação de sequência (se atacar)

**Sprint 1 (quick wins, ~1 dia):**
- #2 Deletar Toolbar
- #3 Renomear DetailModal → DetailPanel
- #7 Fix ThemeToggle
- #8a Eliminar `#34d399`
- #4 Adicionar tokens z-index + breakpoints (definir scale; migração pode ser progressiva)

**Sprint 2 (foundation, ~3-5 dias):**
- #1 Expandir Button/Field/Select API + começar migração (1 módulo de cada vez, começar pelo Settings que é o menor)
- #6 CSS Modules: extrair `investment-*`, `import-*`, `expense-*`, `kanban-*` para `.module.css` adjacentes

**Sprint 3 (polish, ~3-5 dias):**
- #5 Pass nos módulos non-slice (audit, backups, reports, users, workorders, plans, stock, services)
- #10 Redesenhar EmptyState com craft real
- #9 Quebrar ClientImportDialog
- #8b Eliminar os 13 `!important` restantes

---

## Observação final

A fundação que existe é genuinamente boa — melhor que 90% dos SaaS que se vendem como "design-driven". O problema não é gosto, é disciplina de adoção. Os primitives existem mas ninguém os usa. Os tokens existem mas o ThemeToggle os bypassa. Há comentários no CSS admitindo trabalho inacabado.

Para chegar à barra Apple/Linear/Stripe, o trabalho não é construir mais — é **consolidar e adoptar o que já está construído**, e depois fechar as 2 ou 3 lacunas que sobram (EmptyState, empty states em geral, polish nos módulos non-slice).

Essa é a notícia boa: a distância para "world-class" não é uma reescrita, é execução disciplinada.
