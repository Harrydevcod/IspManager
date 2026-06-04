# ISPM SMS Companion (Android)

Companion app that lets the ISPM desktop send SMS through a paired Android phone's
SIM, with **manual approval on the phone** before anything is sent.

## How the loop works

1. Desktop (`Configurações → SMS`) generates a pairing: a random 32-byte secret
   and an `ispm-sms://pair?secret=…&device=…` code.
2. Open that link on the phone (QR/clipboard) → the app stores the shared secret.
3. The phone runs a tiny LAN HTTP server on port **8765**.
4. Desktop enqueues SMS in its durable `sms_outbox` and POSTs each one to
   `http://<phone-ip>:8765/requests`, signed with HMAC-SHA256 over
   `method\npath\ntimestamp\nnonce\nbody` (5-minute replay window).
5. The operator approves on the phone; the app sends via `SmsManager`.
6. Desktop polls `GET /requests/<id>` and reflects `sent` / `failed` / `rejected`.

The canonical signing string is identical on both sides — see
`src/backend/lib/sms-signing.ts` (desktop) and `CompanionServer.verify` (Android).

## Build requirements

This module is **not** built by the desktop toolchain. To build/test it you need:

- JDK 17+
- Android SDK (compileSdk 35) with `ANDROID_HOME`/`ANDROID_SDK_ROOT` set
- Gradle 8.9+ (or generate the wrapper: `gradle wrapper` once, then use `./gradlew`)

```bash
cd android-sms-companion
gradle wrapper          # first time only — produces the gradlew wrapper
./gradlew test          # JVM unit tests (signature parity)
./gradlew assembleDebug # debug APK
```

> The Gradle wrapper jar is intentionally not committed; generate it locally with
> a system Gradle as shown above.
