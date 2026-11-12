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
- **No Chrome, antes do merge.** Um PR que mexe em ecrãs só se funde depois de o smoke correr no Chrome com os ecrãs alterados deixados abertos em abas, para o utilizador os ver ao vivo. Fica tudo a correr até ele dar o visto.
- **Nunca uma release só para corrigir ecrãs.** Um defeito de ecrã corrige-se no próprio PR, antes do merge.
- **Telemóvel (app ISPM SMS).** Um PR que mexe nos ecrãs da app Android (`android-sms-companion/**/ui/**`, tema ou textos) só se funde depois de o utilizador ver as capturas do artefacto `ispm-sms-companion-screens` do CI. São geradas pelo `ScreensSnapshotTest` (Paparazzi), em Pixel 5, ecrã pequeno de 360 dp e letra grande, e cobrem cada estado novo. O teste no telemóvel real faz-se com o APK assinado, antes de anunciar a versão.
- **Largura estreita no desktop: 420 px** (iframe da própria app; a janela da extensão ignora o redimensionamento).
