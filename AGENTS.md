## Agent skills

### Issue tracker

Issues and PRDs for this repo live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five labels from `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context layout. Read `CONTEXT.md` at the repo root if it exists, plus `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.

## Release

Nenhuma release sai sem um **smoke visual** de cada ecrã que ela muda. A release e a tag só se criam depois dele.

- **Onde.** Há duas formas, e ambas usam uma cópia da base (`VACUUM INTO`, com `ISPM_DATA_DIR` a apontar para a cópia), nunca `%APPDATA%\ISPM\ispm.sqlite`:
  - no browser: backend e `vite preview` na porta 5173, a única que o CORS aceita;
  - na app empacotada: `electron-builder --dir` e depois `release/win-unpacked/ISPM.exe`.
- **O quê.** Capturas de cada ecrã alterado à largura real, 1225 px (ecrã de 1920 a 150%), e numa largura estreita. Os estados que se aplicarem: com dados, vazio, erro, fora da rede. Cada fluxo novo é clicado de ponta a ponta. O `/health` 200 sozinho não é smoke.
- **Depois.** As capturas vão para o utilizador antes de lançar. Um defeito encontrado no smoke corrige-se antes da release, não numa versão a seguir.
