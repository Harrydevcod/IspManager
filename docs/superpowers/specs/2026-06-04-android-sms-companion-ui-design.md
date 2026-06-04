# Android SMS Companion — UI/UX Design

> Design contract for the visual/interaction layer of the `android-sms-companion/` app.
> The backend loop (desktop `sms_outbox`, signed transport, `CompanionServer`, `SmsSender`)
> already exists and ships in PR #1. This spec covers **only** the Android UI/UX and one
> small desktop addition (render the pairing QR). No backend protocol changes.

**Date:** 2026-06-04
**Status:** Approved (brainstorming)
**Related:** `docs/superpowers/specs/2026-06-04-android-sms-companion-design.md` (backend/system), `[[ispm-sms-companion]]` memory.

---

## Goal

Replace the bare functional `MainActivity` (a `Column` of `Text` + `Button`) with a
world-class, dark-first Compose interface aligned to the ISPM standard (Apple/Linear/Stripe
sensibility; azul + laranja). The operator glances at the phone and approves/rejects SMS with
confidence and minimal friction.

## Decisions (locked in brainstorming)

1. **Information architecture:** single glanceable screen (no bottom-nav), with a separate
   first-run onboarding flow shown only until paired.
2. **Pairing:** QR scan primary **+** manual code fallback (A+B).
3. **Send safety:** undo window (~5s deferred send, Gmail-style), not a confirm step.

## Non-goals (YAGNI)

- No bottom navigation / multi-tab shell.
- No inbound SMS replies, no cloud relay (already out of scope system-wide).
- No backend/protocol changes. Status flow stays `pending_dispatch → pending_approval → sent/failed/rejected`.
- No history filtering/search; history is a short recent list only.

---

## Architecture

Compose, single-activity, state-driven. Clear units, independently testable:

```
android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/
  MainActivity.kt          # hosts CompanionApp(), owns lifecycle of server + state holder
  ui/
    theme/Theme.kt         # IspmTheme: colors, typography, shapes (dark-first tokens)
    theme/Color.kt         # token palette
    CompanionApp.kt        # root composable: routes Onboarding vs Main by paired state
    OnboardingScreen.kt    # not-paired: QR scanner + manual-code sheet
    MainScreen.kt          # paired: status card + pending list + history + empty state
    components/StatusCard.kt
    components/RequestCard.kt   # includes the undo/sending state
    components/EmptyState.kt
    components/PermissionBanner.kt
  state/
    CompanionState.kt      # data classes: PairingInfo, ServerInfo, RequestUi, CompanionUiState
    CompanionStateHolder.kt# exposes StateFlow<CompanionUiState>; bridges the stores + server
  (existing) PairingStore.kt, SmsRequestStore.kt, CompanionServer.kt, SmsSender.kt
```

**State model.** `CompanionStateHolder` wraps `PairingStore` + `SmsRequestStore` and exposes a
`StateFlow<CompanionUiState>`. `CompanionServer` and approval/undo actions push updates through
it, so Compose recomposes reactively — removing the current manual "Atualizar" button and
`remember(requestStore.list())` snapshotting. The stores remain the source of truth on disk.

```kotlin
data class CompanionUiState(
  val paired: Boolean,
  val deviceName: String,
  val listenAddress: String,        // "192.168.1.50:8765" — local IP + port
  val serverRunning: Boolean,
  val smsPermissionGranted: Boolean,
  val pending: List<RequestUi>,
  val history: List<RequestUi>      // recent terminal-state requests, newest first, capped (e.g. 20)
)

data class RequestUi(
  val id: String,
  val clientName: String?,          // may be null → fall back to phone
  val toPhone: String,
  val eventType: String,            // invoice_issued | receipt_confirmed | payment_overdue | suspension_notice | test
  val body: String,
  val status: String,               // pending_approval | sent | rejected | failed (persisted) — plus the in-memory-only `sending` overlay during the undo window
  val error: String?
)
```

> `clientName` is not currently sent to the phone (the desktop posts `requestId,toPhone,body,eventType`).
> The card shows `clientName` when present and **falls back to `toPhone`** otherwise. Optionally the
> desktop may include a `clientName` field in the `/requests` payload later; this UI must not require it.

## Screens & states

### 1. Onboarding (not paired)
Centered brand wordmark, short lead text, **QR scanner viewport** (dark with laser line + orange
corner guides), primary affordance to scan, and a secondary "Inserir código manualmente" that
opens a bottom sheet with a text field (paste `ispm-sms://pair?secret=…&device=…`) + "Colar da
área de transferência" + "Parear". On a successful scan/parse, persist the secret via
`PairingStore.save(secret, deviceName)` and route to Main. Camera permission is requested only
when the user taps "Ler QR Code"; copy reassures the camera is used solely to read the code.

Deep-link path (`ispm-sms://pair`) continues to work via the existing manifest intent filter and
`handlePairingIntent` — if the app is opened by the link it pairs directly.

### 2. SMS permission
If `SEND_SMS` is not granted, a persistent **inline banner** sits at the top of Main:
"Permitir envio de SMS" → triggers the system permission request. It does not block viewing
pending requests; only the actual send needs the grant. Approving a request while ungranted
re-prompts.

### 3. Main (paired)
- **StatusCard** — "Pareado · {deviceName}", "A ouvir {listenAddress}", "Permissão ✓/✗", and a
  live `Ativo` pill reflecting `serverRunning`.
- **Pending (N)** — scannable `RequestCard`s: client name (or phone), phone subline, event-type
  **badge** (Recibo=laranja, Atraso=vermelho, Fatura=azul, Suspensão=âmbar, Teste=neutro),
  message in a left-ruled quote block, **Aprovar e enviar** (filled blue) + **Rejeitar** (ghost).
- **History** — short list of recent terminal-state requests with subtle status text
  (enviado ✓ / rejeitado / falhou). Capped (~20).
- **Overflow / settings** — minimal: "Revogar pareamento" (clears `PairingStore`, returns to
  Onboarding). Reached via a top-bar overflow icon (kept off the primary surface).

### 4. Empty state
Paired, zero pending: calm centered message "Tudo em dia · à escuta" with the listen address,
so the operator knows it is live and waiting.

## Send-undo micro-interaction

On **Aprovar e enviar**:
1. The `CompanionStateHolder` marks the request as `sending` **in memory only** (the persisted
   `SmsRequestStore` row stays `pending_approval`); the card shows "A enviar a {name}… **Anular**"
   with a ~5s countdown affordance.
2. A coroutine schedules the real send after ~5s.
3. **Anular** cancels the coroutine and clears the in-memory overlay → card returns to its
   `pending_approval` rendering. Nothing was persisted, nothing was sent.
4. On expiry: `SmsSender.send(toPhone, body)` fires; on success `updateStatus(id,"sent")`, on throw
   `updateStatus(id,"failed", message)` (now persisted), and the overlay clears.

This is **Android-side only**. The desktop poller still observes `pending_approval` until the send
completes, then `sent` — no backend change. The `sending` state is local UI and is **not** reported
over HTTP (the `/requests/{id}` status endpoint keeps returning `pending_approval` during the
window). If the app is killed mid-window the request stays pending and is re-approved later
(best-effort; acceptable).

## Desktop addition (small, in-scope)

`src/renderer/modules/SettingsModule.tsx` SMS tab currently shows the `qrPayload` as text. Render
it as a **QR code image** (the project already includes a QR package — reuse the same one used for
fiscal QR) alongside the textual code (kept as the manual fallback). This enables pairing path A.
No new backend route; the `qrPayload` already comes from `POST /api/sms/pairing`.

## Design tokens (dark-first)

| Token | Value |
|------|-------|
| bg / app | `#05070b` |
| surface | `#111722` |
| border | `#1e2533` |
| text / primary | `#e7ecf3` |
| text / secondary | `#9aa6b8` |
| text / muted | `#6b7689` |
| accent / primary (action) | `#2563eb` (azul) |
| accent / brand (highlight) | `#f97316` (laranja) |
| semantic / success | `#4ade80` · `#22c55e` |
| semantic / danger | `#f87171` · `#ef4444` |
| semantic / warn | `#fbbf24` |

Type: Inter (Compose `FontFamily`; bundle the variable font or use the closest system fallback),
editorial scale. Shapes: 14–16px card radii, 10–11px buttons. Soft shadows/elevation appropriate
to dark surfaces.

## Components & isolation

- **StatusCard(state)** — pure render of pairing/server/permission summary. No logic.
- **RequestCard(request, onApprove, onReject, onUndo)** — renders one request incl. the
  `sending`/undo state; emits callbacks only.
- **EmptyState(listenAddress)** — static.
- **PermissionBanner(onRequest)** — visible only when ungranted.
- **OnboardingScreen(onScan, onManualSubmit)** — scanner + manual sheet; pairing parse is a pure
  function `parsePairingPayload(uri): PairingInfo?`.
- **CompanionStateHolder** — the only stateful unit; everything else is driven by its `StateFlow`.

## Dependencies added (Android)

- A QR scanner: **ML Kit Barcode Scanning** + CameraX preview (or ZXing `journeyapps` embedded
  scanner as a lighter alternative). Decision deferred to the plan; both are viable. Adds
  `android.permission.CAMERA`.
- No new desktop deps (QR package already present).

## Error / edge handling

- Camera permission denied → keep manual-code path available; show a gentle inline note.
- Malformed/foreign QR (`parsePairingPayload` returns null) → toast "Código de pareamento inválido", no state change.
- Send throws (no SIM / no permission) → request → `failed` with the exception message surfaced on the card; re-approvable.
- Server not running (`serverRunning=false`) → StatusCard shows a non-live state; pending list still renders from disk.
- App killed during undo window → request remains `pending_approval`.

## Testing

JVM unit tests (no device; run in existing CI `android.yml`):
- `parsePairingPayload` — valid `ispm-sms://pair` extracts secret+device; rejects junk/missing secret.
- `SmsRequestStore` reducer behaviors — `upsert`, `updateStatus`, undo path (sending → pending_approval).
- State mapping — store rows → `CompanionUiState` (pending vs history partition, fallback name = phone, history cap).
- Existing signature parity test retained.

Instrumented/visual checks (manual, on-device — owed, needs a phone): pairing via QR and via
manual code; permission grant; approve with undo; reject; empty state; dark rendering.

## Build / CI

Reuse `.github/workflows/android.yml` (JDK 17 + Android SDK + Gradle 8.10.2). New deps (CameraX/ML
Kit or ZXing) resolve via the existing setup; `gradle test` + `assembleDebug` continue to gate and
publish the debug APK artifact.
