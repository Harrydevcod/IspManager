# ADR 0001: Local Markdown Issues and Single-Context Docs

## Status

Accepted

## Context

ISPM is a small desktop app with no git remote configured in this workspace, so the engineering skills need a repo-local way to track work. The repository also uses one shared glossary and one shared set of architectural decisions rather than split per-module documentation.

## Decision

- Track issues and PRDs in local markdown files under `.scratch/`.
- Use a single-context documentation layout with `CONTEXT.md` at the repo root.
- Keep architectural decisions in `docs/adr/` at the repo root.

## Consequences

- Skills such as `to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, and `zoom-out` can read and write repo-local markdown without relying on GitHub or GitLab.
- Future work can reference a stable glossary in `CONTEXT.md` and preserve decisions in `docs/adr/`.
- If the project later adopts a remote issue tracker or multiple bounded contexts, these docs will need to be updated together.
