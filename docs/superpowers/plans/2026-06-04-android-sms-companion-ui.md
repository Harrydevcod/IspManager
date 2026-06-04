# Android SMS Companion UI/UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `MainActivity` with a world-class dark-first Compose UI for the SMS companion — onboarding (QR + manual pairing), a single glanceable main screen (status, pending approvals with a 5s undo window, history), driven by an observable state holder; plus two small desktop additions (render the pairing QR, send `clientName` in the dispatch payload).

**Architecture:** Single-activity Jetpack Compose. A `CompanionStateHolder` exposes `StateFlow<CompanionUiState>` built from the existing on-disk stores; Compose renders reactively. Pure, JVM-testable units (`buildUiState`, `parsePairingPayload`, `UndoController`) carry the logic; Android-bound glue (holder, activity, server wiring) is verified by build + manual smoke. The send-undo is an in-memory overlay — the persisted store and the desktop protocol are unchanged.

**Tech Stack:** Kotlin, Jetpack Compose (Material3), Coroutines, ZXing Android Embedded (QR scan), NanoHTTPD (existing). Desktop: React + `qrcode` (existing). 

**Verification reality:** This dev environment has **no Android SDK/Gradle** (only Java 8). Android tasks are verified by pushing the branch and reading the existing `.github/workflows/android.yml` CI run (`gradle test` for JVM unit tests, `assembleDebug` for compilation). Desktop tasks (9, 10) are verified locally with `npm`. Per-task "run test" steps therefore mean: commit, push, and confirm the CI job is green for that step's tests.

---

## File Structure

Android (`android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/`):
- `ui/theme/Color.kt` *(new)* — token palette.
- `ui/theme/Type.kt` *(new)* — editorial Typography.
- `ui/theme/Theme.kt` *(new)* — `IspmTheme` dark color scheme + shapes.
- `ui/theme/Badges.kt` *(new)* — event-type → label/color mapping.
- `state/CompanionState.kt` *(new)* — `RequestUi`, `CompanionUiState`, `PairingSnapshot`, `buildUiState`.
- `state/PairingPayload.kt` *(new)* — `PairingInfo`, `parsePairingPayload` (pure JVM).
- `state/UndoController.kt` *(new)* — deferred-send/undo timing (pure coroutines).
- `state/CompanionStateHolder.kt` *(new)* — `StateFlow<CompanionUiState>` + actions.
- `net/DeviceAddress.kt` *(new)* — local IPv4 helper.
- `ui/components/StatusCard.kt`, `PermissionBanner.kt`, `EmptyState.kt`, `RequestCard.kt` *(new)*.
- `ui/MainScreen.kt`, `ui/OnboardingScreen.kt`, `ui/CompanionApp.kt` *(new)*.
- `MainActivity.kt` *(rewrite)*.
- `SmsRequestStore.kt` *(modify)* — add `clientName` field + serialization.
- `CompanionServer.kt` *(modify)* — parse `clientName`; fire `onRequestsChanged`.
- `app/build.gradle.kts` *(modify)* — deps.

Tests (`android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/`):
- `state/BuildUiStateTest.kt`, `state/PairingPayloadTest.kt`, `state/UndoControllerTest.kt` *(new)*; existing `SignatureTest.kt` retained.

Desktop:
- `src/backend/lib/sms-outbox.ts` *(modify)* + `src/backend/lib/sms-outbox.test.ts` *(modify)*.
- `src/renderer/modules/SettingsModule.tsx` *(modify)*.

---

## Task 1: Android dependencies + dark theme tokens

**Files:**
- Modify: `android-sms-companion/app/build.gradle.kts`
- Create: `.../ui/theme/Color.kt`, `.../ui/theme/Type.kt`, `.../ui/theme/Theme.kt`

- [ ] **Step 1: Add dependencies**

In `app/build.gradle.kts`, replace the `dependencies { }` block with:

```kotlin
dependencies {
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.ui:ui:1.7.5")
  implementation("androidx.compose.material3:material3:1.3.1")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  implementation("org.nanohttpd:nanohttpd:2.3.1")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
```

- [ ] **Step 2: Color tokens**

Create `ui/theme/Color.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.theme

import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF05070B)
val Surface = Color(0xFF111722)
val SurfaceMuted = Color(0xFF0B0E14)
val BorderC = Color(0xFF1E2533)
val TextPrimary = Color(0xFFE7ECF3)
val TextSecondary = Color(0xFF9AA6B8)
val TextMuted = Color(0xFF6B7689)
val AccentBlue = Color(0xFF2563EB)
val AccentOrange = Color(0xFFF97316)
val Success = Color(0xFF4ADE80)
val Danger = Color(0xFFF87171)
val Warn = Color(0xFFFBBF24)
```

- [ ] **Step 3: Typography**

Create `ui/theme/Type.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Inter can be bundled into res/font later; system default keeps the build asset-free.
private val Sans = FontFamily.Default

val IspmTypography = Typography(
  titleLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.2).sp),
  titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, letterSpacing = (-0.1).sp),
  bodyMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 14.sp),
  bodySmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 12.sp),
  labelSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.8.sp)
)
```

- [ ] **Step 4: Theme**

Create `ui/theme/Theme.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val DarkColors = darkColorScheme(
  primary = AccentBlue,
  onPrimary = TextPrimary,
  secondary = AccentOrange,
  background = Bg,
  onBackground = TextPrimary,
  surface = Surface,
  onSurface = TextPrimary,
  error = Danger
)

private val IspmShapes = Shapes(
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(14.dp),
  large = RoundedCornerShape(16.dp)
)

@Composable
fun IspmTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = DarkColors, typography = IspmTypography, shapes = IspmShapes, content = content)
}
```

- [ ] **Step 5: Commit, push, verify CI compiles**

```bash
git add android-sms-companion/app/build.gradle.kts android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/ui/theme/
git commit -m "feat(sms-ui): add Compose deps and dark theme tokens"
git push
```

Expected: `android.yml` job green (deps resolve, `assembleDebug` still compiles — no usages yet).

---

## Task 2: UI state model + `buildUiState` mapping (+ clientName on SmsRequest)

**Files:**
- Modify: `.../SmsRequestStore.kt`
- Create: `.../state/CompanionState.kt`
- Test: `.../test/.../state/BuildUiStateTest.kt`

- [ ] **Step 1: Add `clientName` to `SmsRequest` + serialization**

In `SmsRequestStore.kt`, update the data class and (de)serialization. Replace the `data class SmsRequest(...)` line with:

```kotlin
data class SmsRequest(
  val id: String,
  val toPhone: String,
  val body: String,
  val eventType: String,
  val status: String,
  val error: String?,
  val clientName: String? = null
)
```

In `list()`, replace the `SmsRequest(...)` construction with:

```kotlin
      SmsRequest(
        obj.getString("id"),
        obj.getString("toPhone"),
        obj.getString("body"),
        obj.getString("eventType"),
        obj.getString("status"),
        obj.optString("error").ifBlank { null },
        if (obj.has("clientName") && !obj.isNull("clientName")) obj.optString("clientName").ifBlank { null } else null
      )
```

In `save(...)`, add `clientName` to the JSON object — change the `array.put(JSONObject()...)` chain to end with:

```kotlin
          .put("status", it.status)
          .put("error", it.error ?: "")
          .put("clientName", it.clientName ?: "")
```

- [ ] **Step 2: Write the failing test for `buildUiState`**

Create `test/.../state/BuildUiStateTest.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BuildUiStateTest {
  private fun req(id: String, status: String, name: String? = null) =
    SmsRequest(id = id, toPhone = "+2389912233", body = "ola", eventType = "receipt_confirmed", status = status, error = null, clientName = name)

  private val pairing = PairingSnapshot(paired = true, deviceName = "Loja", listenAddress = "192.168.1.50:8765")

  @Test fun partitionsPendingAndHistory() {
    val s = buildUiState(pairing, serverRunning = true, smsPermissionGranted = true,
      requests = listOf(req("1", "pending_approval"), req("2", "sent"), req("3", "rejected")), sendingIds = emptySet())
    assertEquals(listOf("1"), s.pending.map { it.id })
    assertEquals(setOf("2", "3"), s.history.map { it.id }.toSet())
  }

  @Test fun historyIsNewestFirstAndCapped() {
    val sent = (1..25).map { req(it.toString(), "sent") }
    val s = buildUiState(pairing, true, true, sent, emptySet())
    assertEquals(20, s.history.size)
    assertEquals("25", s.history.first().id) // newest first
  }

  @Test fun clientNameCarriedWithPhoneFallback() {
    val s = buildUiState(pairing, true, true, listOf(req("1", "pending_approval", "Ana Lopes"), req("2", "pending_approval", null)), emptySet())
    assertEquals("Ana Lopes", s.pending.first { it.id == "1" }.clientName)
    assertNull(s.pending.first { it.id == "2" }.clientName)
  }

  @Test fun sendingOverlayMarksRequest() {
    val s = buildUiState(pairing, true, true, listOf(req("1", "pending_approval")), sendingIds = setOf("1"))
    assertEquals(true, s.pending.first().sending)
  }
}
```

- [ ] **Step 3: Run test to verify it fails**

Push and check CI (or locally if Android SDK present): `gradle test`. Expected: FAIL — `CompanionState`/`buildUiState` unresolved.

- [ ] **Step 4: Implement `CompanionState.kt`**

Create `state/CompanionState.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest

const val HISTORY_LIMIT = 20
private val TERMINAL = setOf("sent", "rejected", "failed")

data class RequestUi(
  val id: String,
  val clientName: String?,
  val toPhone: String,
  val eventType: String,
  val body: String,
  val status: String,
  val error: String?,
  val sending: Boolean = false
)

data class PairingSnapshot(val paired: Boolean, val deviceName: String, val listenAddress: String)

data class CompanionUiState(
  val paired: Boolean = false,
  val deviceName: String = "",
  val listenAddress: String = "",
  val serverRunning: Boolean = false,
  val smsPermissionGranted: Boolean = false,
  val pending: List<RequestUi> = emptyList(),
  val history: List<RequestUi> = emptyList()
)

private fun SmsRequest.toUi(sending: Boolean) = RequestUi(
  id = id, clientName = clientName, toPhone = toPhone, eventType = eventType,
  body = body, status = status, error = error, sending = sending
)

fun buildUiState(
  pairing: PairingSnapshot,
  serverRunning: Boolean,
  smsPermissionGranted: Boolean,
  requests: List<SmsRequest>,
  sendingIds: Set<String>
): CompanionUiState {
  val ui = requests.map { it.toUi(sendingIds.contains(it.id)) }
  val pending = ui.filter { it.status == "pending_approval" }
  val history = ui.filter { it.status in TERMINAL }.asReversed().take(HISTORY_LIMIT)
  return CompanionUiState(
    paired = pairing.paired,
    deviceName = pairing.deviceName,
    listenAddress = pairing.listenAddress,
    serverRunning = serverRunning,
    smsPermissionGranted = smsPermissionGranted,
    pending = pending,
    history = history
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Push; CI `gradle test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/SmsRequestStore.kt android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/state/CompanionState.kt android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/state/BuildUiStateTest.kt
git commit -m "feat(sms-ui): UI state model, clientName field, buildUiState mapping"
git push
```

---

## Task 3: Pairing payload parser

**Files:**
- Create: `.../state/PairingPayload.kt`
- Test: `.../test/.../state/PairingPayloadTest.kt`

- [ ] **Step 1: Write the failing test**

Create `test/.../state/PairingPayloadTest.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingPayloadTest {
  @Test fun parsesSecretAndDevice() {
    val info = parsePairingPayload("ispm-sms://pair?secret=9f3a&device=Loja%20Praia")
    assertEquals("9f3a", info?.secret)
    assertEquals("Loja Praia", info?.deviceName)
  }

  @Test fun defaultsDeviceWhenMissing() {
    assertEquals("ISPM Desktop", parsePairingPayload("ispm-sms://pair?secret=abc")?.deviceName)
  }

  @Test fun rejectsWrongSchemeOrMissingSecret() {
    assertNull(parsePairingPayload("https://example.com?secret=abc"))
    assertNull(parsePairingPayload("ispm-sms://pair?device=Loja"))
    assertNull(parsePairingPayload("garbage"))
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Push; CI `gradle test`. Expected: FAIL — `parsePairingPayload` unresolved.

- [ ] **Step 3: Implement (pure JVM, no `android.net.Uri`)**

Create `state/PairingPayload.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import java.net.URLDecoder

data class PairingInfo(val secret: String, val deviceName: String)

fun parsePairingPayload(raw: String): PairingInfo? {
  val trimmed = raw.trim()
  if (!trimmed.startsWith("ispm-sms://pair")) return null
  val query = trimmed.substringAfter('?', "")
  val params = query.split('&').mapNotNull { part ->
    val i = part.indexOf('=')
    if (i <= 0) null else
      URLDecoder.decode(part.substring(0, i), "UTF-8") to URLDecoder.decode(part.substring(i + 1), "UTF-8")
  }.toMap()
  val secret = params["secret"]?.takeIf { it.isNotBlank() } ?: return null
  val device = params["device"]?.takeIf { it.isNotBlank() } ?: "ISPM Desktop"
  return PairingInfo(secret, device)
}
```

- [ ] **Step 4: Run test to verify it passes**

Push; CI `gradle test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/state/PairingPayload.kt android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/state/PairingPayloadTest.kt
git commit -m "feat(sms-ui): pure pairing-payload parser"
git push
```

---

## Task 4: Undo controller (deferred send)

**Files:**
- Create: `.../state/UndoController.kt`
- Test: `.../test/.../state/UndoControllerTest.kt`

- [ ] **Step 1: Write the failing test**

Create `test/.../state/UndoControllerTest.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UndoControllerTest {
  @Test fun sendsAfterWindowElapses() = runTest {
    val sent = mutableListOf<String>()
    val undo = UndoController(this, delayMillis = 5000, onSend = { sent.add(it) })
    undo.arm("1") {}
    assertTrue(undo.sendingIds.contains("1"))
    advanceTimeBy(5001)
    assertEquals(listOf("1"), sent)
    assertFalse(undo.sendingIds.contains("1"))
  }

  @Test fun cancelPreventsSend() = runTest {
    val sent = mutableListOf<String>()
    val undo = UndoController(this, delayMillis = 5000, onSend = { sent.add(it) })
    undo.arm("1") {}
    undo.cancel("1") {}
    assertFalse(undo.sendingIds.contains("1"))
    advanceTimeBy(6000)
    assertTrue(sent.isEmpty())
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Push; CI `gradle test`. Expected: FAIL — `UndoController` unresolved.

- [ ] **Step 3: Implement**

Create `state/UndoController.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Holds armed sends for [delayMillis]; cancel within the window aborts the send. */
class UndoController(
  private val scope: CoroutineScope,
  private val delayMillis: Long = 5000,
  private val onSend: suspend (String) -> Unit
) {
  private val jobs = mutableMapOf<String, Job>()
  val sendingIds: Set<String> get() = jobs.keys.toSet()

  fun arm(id: String, onChange: () -> Unit) {
    jobs.remove(id)?.cancel()
    jobs[id] = scope.launch {
      try {
        delay(delayMillis)
        onSend(id)
      } finally {
        jobs.remove(id)
        onChange()
      }
    }
    onChange()
  }

  fun cancel(id: String, onChange: () -> Unit) {
    jobs.remove(id)?.cancel()
    onChange()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Push; CI `gradle test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/state/UndoController.kt android-sms-companion/app/src/test/java/cv/novatech/ispm/sms/state/UndoControllerTest.kt
git commit -m "feat(sms-ui): undo controller for deferred sends"
git push
```

---

## Task 5: UI components (badges, status, banner, empty, request card)

**Files:**
- Create: `.../ui/theme/Badges.kt`, `.../ui/components/StatusCard.kt`, `.../ui/components/PermissionBanner.kt`, `.../ui/components/EmptyState.kt`, `.../ui/components/RequestCard.kt`

- [ ] **Step 1: Badge mapping**

Create `ui/theme/Badges.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.theme

import androidx.compose.ui.graphics.Color

data class BadgeStyle(val label: String, val fg: Color, val bg: Color)

fun badgeFor(eventType: String): BadgeStyle = when (eventType) {
  "receipt_confirmed" -> BadgeStyle("Recibo", AccentOrange, AccentOrange.copy(alpha = 0.14f))
  "payment_overdue" -> BadgeStyle("Atraso", Danger, Danger.copy(alpha = 0.14f))
  "invoice_issued" -> BadgeStyle("Fatura", AccentBlue, AccentBlue.copy(alpha = 0.16f))
  "suspension_notice" -> BadgeStyle("Suspensão", Warn, Warn.copy(alpha = 0.14f))
  else -> BadgeStyle("Teste", TextSecondary, BorderC)
}
```

- [ ] **Step 2: StatusCard**

Create `ui/components/StatusCard.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun StatusCard(deviceName: String, listenAddress: String, serverRunning: Boolean, permissionGranted: Boolean) {
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
      Text("Pareado · $deviceName", color = TextPrimary, fontWeight = FontWeight.SemiBold)
      LivePill(serverRunning)
    }
    Spacer(Modifier.height(6.dp))
    Text("A ouvir $listenAddress", color = TextSecondary, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
    Text(
      if (permissionGranted) "Permissão SMS ✓" else "Permissão SMS em falta",
      color = if (permissionGranted) Success else Warn,
      style = androidx.compose.material3.MaterialTheme.typography.bodySmall
    )
  }
}

@Composable
private fun LivePill(running: Boolean) {
  val c = if (running) Success else TextMuted
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(6.dp).clip(CircleShape).background(c))
    Spacer(Modifier.width(5.dp))
    Text(if (running) "Ativo" else "Parado", color = c, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
  }
}
```

- [ ] **Step 3: PermissionBanner**

Create `ui/components/PermissionBanner.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun PermissionBanner(onRequest: () -> Unit) {
  Row(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(12.dp)).background(Warn.copy(alpha = 0.12f))
      .clickable { onRequest() }.padding(14.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween
  ) {
    Text("Permitir envio de SMS", color = Warn, fontWeight = FontWeight.SemiBold)
    Text("Permitir →", color = Warn)
  }
}
```

- [ ] **Step 4: EmptyState**

Create `ui/components/EmptyState.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextSecondary

@Composable
fun EmptyState(listenAddress: String) {
  Column(
    Modifier.fillMaxWidth().padding(vertical = 48.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("Tudo em dia", color = TextSecondary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Text("À escuta em $listenAddress", color = TextMuted, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
  }
}
```

- [ ] **Step 5: RequestCard (with sending/undo state)**

Create `ui/components/RequestCard.kt`:

```kotlin
package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun RequestCard(req: RequestUi, onApprove: () -> Unit, onReject: () -> Unit, onUndo: () -> Unit) {
  val badge = badgeFor(req.eventType)
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(16.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(16.dp))
      .padding(13.dp)
  ) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
      Column(Modifier.weight(1f)) {
        Text(req.clientName ?: req.toPhone, color = TextPrimary, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
        Text(req.toPhone, color = TextMuted, style = MaterialTheme.typography.bodySmall)
      }
      Box(Modifier.clip(RoundedCornerShape(6.dp)).background(badge.bg).padding(horizontal = 7.dp, vertical = 3.dp)) {
        Text(badge.label, color = badge.fg, style = MaterialTheme.typography.labelSmall)
      }
    }
    Spacer(Modifier.height(10.dp))
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(SurfaceMuted).padding(10.dp)) {
      Text(req.body, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
    }
    Spacer(Modifier.height(12.dp))
    if (req.sending) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text("A enviar a ${req.clientName ?: req.toPhone}…", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onUndo) { Text("Anular", color = AccentOrange, fontWeight = FontWeight.SemiBold) }
      }
    } else {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = onApprove, modifier = Modifier.weight(1f),
          colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, contentColor = Color.White)
        ) { Text("Aprovar e enviar") }
        OutlinedButton(onClick = onReject, modifier = Modifier.weight(1f)) { Text("Rejeitar", color = TextSecondary) }
      }
    }
  }
}
```

- [ ] **Step 6: Commit, push, verify CI compiles**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/ui/
git commit -m "feat(sms-ui): status, banner, empty and request-card composables"
git push
```

Expected: `assembleDebug` compiles (components unused yet — acceptable).

---

## Task 6: MainScreen

**Files:**
- Create: `.../ui/MainScreen.kt`

- [ ] **Step 1: Implement**

Create `ui/MainScreen.kt`:

```kotlin
package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.ui.components.*
import cv.novatech.ispm.sms.ui.theme.TextMuted

@Composable
fun MainScreen(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onApprove: (String) -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit
) {
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Text("ISPM SMS", style = MaterialTheme.typography.titleLarge) }
    if (!state.smsPermissionGranted) item { PermissionBanner(onRequestPermission) }
    item { StatusCard(state.deviceName, state.listenAddress, state.serverRunning, state.smsPermissionGranted) }

    item { SectionLabel("Pendentes · ${state.pending.size}") }
    if (state.pending.isEmpty()) {
      item { EmptyState(state.listenAddress) }
    } else {
      items(state.pending, key = { it.id }) { r ->
        RequestCard(r, onApprove = { onApprove(r.id) }, onReject = { onReject(r.id) }, onUndo = { onUndo(r.id) })
      }
    }

    if (state.history.isNotEmpty()) {
      item { SectionLabel("Histórico") }
      items(state.history, key = { "h-" + it.id }) { r -> HistoryRow(r) }
    }
  }
}

@Composable
private fun SectionLabel(text: String) {
  Text(text, color = TextMuted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp, start = 4.dp))
}

@Composable
private fun HistoryRow(r: cv.novatech.ispm.sms.state.RequestUi) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
    Text("${r.clientName ?: r.toPhone}", color = TextMuted, style = MaterialTheme.typography.bodySmall)
    val label = when (r.status) { "sent" -> "enviado ✓"; "rejected" -> "rejeitado"; else -> "falhou" }
    Text(label, color = TextMuted, style = MaterialTheme.typography.bodySmall)
  }
}
```

- [ ] **Step 2: Commit + push (CI compile)**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/ui/MainScreen.kt
git commit -m "feat(sms-ui): main screen composable"
git push
```

---

## Task 7: OnboardingScreen (QR scan + manual)

**Files:**
- Create: `.../ui/OnboardingScreen.kt`

- [ ] **Step 1: Implement**

Create `ui/OnboardingScreen.kt`:

```kotlin
package cv.novatech.ispm.sms.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.theme.AccentOrange
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextSecondary

@Composable
fun OnboardingScreen(onPaired: (PairingInfo) -> Unit, onInvalid: () -> Unit) {
  var showManual by remember { mutableStateOf(false) }

  val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
    val contents = result.contents
    if (contents == null) return@rememberLauncherForActivityResult
    val info = parsePairingPayload(contents)
    if (info != null) onPaired(info) else onInvalid()
  }

  Column(
    Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center
  ) {
    Text("ISPM SMS", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(8.dp))
    Text(
      "Para parear, lê o QR Code que aparece no ISPM (Configurações → SMS).",
      color = TextSecondary, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium
    )
    Spacer(Modifier.height(24.dp))
    Button(
      onClick = {
        scanLauncher.launch(ScanOptions().setOrientationLocked(false).setBeepEnabled(false).setPrompt("Aponta ao QR do ISPM"))
      },
      modifier = Modifier.fillMaxWidth()
    ) { Text("Ler QR Code") }
    Spacer(Modifier.height(10.dp))
    OutlinedButton(onClick = { showManual = true }, modifier = Modifier.fillMaxWidth()) {
      Text("Inserir código manualmente", color = TextSecondary)
    }
    Spacer(Modifier.height(16.dp))
    Text("A câmara é usada apenas para ler o código de pareamento.", color = TextMuted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
  }

  if (showManual) {
    ManualPairSheet(
      onDismiss = { showManual = false },
      onSubmit = { raw ->
        val info = parsePairingPayload(raw)
        showManual = false
        if (info != null) onPaired(info) else onInvalid()
      }
    )
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManualPairSheet(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
  var text by remember { mutableStateOf("") }
  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.padding(20.dp).fillMaxWidth()) {
      Text("Código de pareamento", style = MaterialTheme.typography.titleMedium)
      Spacer(Modifier.height(12.dp))
      OutlinedTextField(
        value = text, onValueChange = { text = it },
        placeholder = { Text("ispm-sms://pair?secret=…") },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions.Default
      )
      Spacer(Modifier.height(12.dp))
      Button(onClick = { onSubmit(text) }, enabled = text.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
        Text("Parear")
      }
      Spacer(Modifier.height(8.dp))
    }
  }
}
```

- [ ] **Step 2: Commit + push (CI compile)**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/ui/OnboardingScreen.kt
git commit -m "feat(sms-ui): onboarding with QR scan and manual pairing"
git push
```

---

## Task 8: State holder, app shell, server wiring, MainActivity rewrite

**Files:**
- Create: `.../net/DeviceAddress.kt`, `.../state/CompanionStateHolder.kt`, `.../ui/CompanionApp.kt`
- Modify: `.../CompanionServer.kt`, `.../MainActivity.kt`

- [ ] **Step 1: Local address helper**

Create `net/DeviceAddress.kt`:

```kotlin
package cv.novatech.ispm.sms.net

import java.net.Inet4Address
import java.net.NetworkInterface

/** Best-effort LAN IPv4 of this device, for display ("192.168.x.y:8765"). */
fun localIpv4(): String {
  return runCatching {
    NetworkInterface.getNetworkInterfaces().toList()
      .filter { it.isUp && !it.isLoopback }
      .flatMap { it.inetAddresses.toList() }
      .filterIsInstance<Inet4Address>()
      .firstOrNull { it.isSiteLocalAddress }?.hostAddress
  }.getOrNull() ?: "este dispositivo"
}
```

- [ ] **Step 2: CompanionServer — accept `clientName` + change callback**

In `CompanionServer.kt`, change the constructor to add a change callback:

```kotlin
class CompanionServer(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  port: Int = 8765,
  private val onRequestsChanged: () -> Unit = {}
) : NanoHTTPD(port) {
```

In the POST `/requests` branch, replace the `requestStore.upsert(...)` + return with:

```kotlin
      requestStore.upsert(
        SmsRequest(
          id = id,
          toPhone = json.getString("toPhone"),
          body = json.getString("body"),
          eventType = json.optString("eventType", "test"),
          status = "pending_approval",
          error = null,
          clientName = if (json.has("clientName") && !json.isNull("clientName")) json.optString("clientName").ifBlank { null } else null
        )
      )
      onRequestsChanged()
      return json(Response.Status.OK, """{"id":"$id","status":"pending_approval"}""")
```

- [ ] **Step 3: CompanionStateHolder**

Create `state/CompanionStateHolder.kt`:

```kotlin
package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.PairingStore
import cv.novatech.ispm.sms.SmsRequest
import cv.novatech.ispm.sms.SmsRequestStore
import cv.novatech.ispm.sms.net.localIpv4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class CompanionStateHolder(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  scope: CoroutineScope,
  private val send: (SmsRequest) -> Unit
) {
  private val _state = MutableStateFlow(CompanionUiState())
  val state: StateFlow<CompanionUiState> = _state

  private var serverRunning = false
  private var permissionGranted = false
  private val undo = UndoController(scope, onSend = ::performSend)

  fun refresh() {
    val snap = PairingSnapshot(pairingStore.isPaired(), pairingStore.deviceName(), "${localIpv4()}:8765")
    _state.value = buildUiState(snap, serverRunning, permissionGranted, requestStore.list(), undo.sendingIds)
  }

  fun setServerRunning(value: Boolean) { serverRunning = value; refresh() }
  fun setPermissionGranted(value: Boolean) { permissionGranted = value; refresh() }
  fun pair(info: PairingInfo) { pairingStore.save(info.secret, info.deviceName); refresh() }
  fun unpair() { pairingStore.clear(); refresh() }

  fun approve(id: String) = undo.arm(id) { refresh() }
  fun undoApprove(id: String) = undo.cancel(id) { refresh() }
  fun reject(id: String) { requestStore.updateStatus(id, "rejected", "Rejeitado no Android"); refresh() }

  private suspend fun performSend(id: String) {
    val req = requestStore.find(id) ?: return
    try {
      send(req)
      requestStore.updateStatus(id, "sent", null)
    } catch (e: Exception) {
      requestStore.updateStatus(id, "failed", e.message ?: "Falha no envio SMS")
    }
  }
}
```

- [ ] **Step 4: CompanionApp shell**

Create `ui/CompanionApp.kt`:

```kotlin
package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.ui.theme.Bg

@Composable
fun CompanionApp(
  state: CompanionUiState,
  onPaired: (PairingInfo) -> Unit,
  onInvalidPairing: () -> Unit,
  onRequestPermission: () -> Unit,
  onApprove: (String) -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit
) {
  Surface(Modifier.fillMaxSize().background(Bg)) {
    if (!state.paired) {
      OnboardingScreen(onPaired = onPaired, onInvalid = onInvalidPairing)
    } else {
      MainScreen(state, onRequestPermission, onApprove, onUndo, onReject)
    }
  }
}
```

- [ ] **Step 5: Rewrite MainActivity**

Replace `MainActivity.kt` entirely with:

```kotlin
package cv.novatech.ispm.sms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import cv.novatech.ispm.sms.state.CompanionStateHolder
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.CompanionApp
import cv.novatech.ispm.sms.ui.theme.IspmTheme

class MainActivity : ComponentActivity() {
  private lateinit var pairingStore: PairingStore
  private lateinit var requestStore: SmsRequestStore
  private lateinit var holder: CompanionStateHolder
  private var server: CompanionServer? = null

  private val permissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      holder.setPermissionGranted(granted)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    pairingStore = PairingStore(this)
    requestStore = SmsRequestStore(this)
    holder = CompanionStateHolder(
      pairingStore = pairingStore,
      requestStore = requestStore,
      scope = lifecycleScope,
      send = { req -> SmsSender.send(this, req.toPhone, req.body) }
    )

    handlePairingIntent(intent)

    server = CompanionServer(pairingStore, requestStore, onRequestsChanged = { runOnUiThread { holder.refresh() } })
      .also { runCatching { it.start() } }
    holder.setServerRunning(server != null)
    holder.setPermissionGranted(
      ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
    )

    setContent {
      IspmTheme {
        val state by holder.state.collectAsStateWithLifecycle()
        CompanionApp(
          state = state,
          onPaired = { holder.pair(it) },
          onInvalidPairing = { toast("Código de pareamento inválido") },
          onRequestPermission = { permissionLauncher.launch(Manifest.permission.SEND_SMS) },
          onApprove = { id ->
            if (state.smsPermissionGranted) holder.approve(id)
            else permissionLauncher.launch(Manifest.permission.SEND_SMS)
          },
          onUndo = { holder.undoApprove(it) },
          onReject = { holder.reject(it) }
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    if (::holder.isInitialized) holder.refresh()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handlePairingIntent(intent)
  }

  private fun handlePairingIntent(intent: Intent?) {
    val data = intent?.dataString ?: return
    val info: PairingInfo = parsePairingPayload(data) ?: return
    if (::holder.isInitialized) holder.pair(info) else pairingStore.save(info.secret, info.deviceName)
  }

  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  override fun onDestroy() {
    server?.stop()
    super.onDestroy()
  }
}
```

- [ ] **Step 6: Commit, push, verify full CI green**

```bash
git add android-sms-companion/app/src/main/java/cv/novatech/ispm/sms/
git commit -m "feat(sms-ui): state holder, app shell, server wiring, activity rewrite"
git push
```

Expected: `android.yml` green — `gradle test` (all unit tests) + `assembleDebug` produce the APK artifact.

---

## Task 9: Desktop — send `clientName` in the dispatch payload

**Files:**
- Modify: `src/backend/lib/sms-outbox.ts`
- Test: `src/backend/lib/sms-outbox.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/lib/sms-outbox.test.ts` inside the `describe('SMS outbox', ...)` block:

```ts
  test('default transport includes clientName resolved from the client', async () => {
    db.prepare(`INSERT INTO app_settings (key,value) VALUES ('smsCompanionPairingKey','secret')`).run();
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('SMS-N','Ana Lopes','active')`).run().lastInsertRowid as number;
    let body: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'android-1' }) };
    }));
    enqueueSmsNotification({ eventType: 'test', toPhone: '+2389912233', body: 'teste', clientId });
    await runSmsOutboxIfDue(new Date());
    expect(body.clientName).toBe('Ana Lopes');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run src/backend/lib/sms-outbox.test.ts --no-file-parallelism`
Expected: FAIL — posted body has no `clientName`.

- [ ] **Step 3: Resolve and include `clientName`**

In `src/backend/lib/sms-outbox.ts`, update the dispatch query in `runSmsOutboxIfDue` to join the client name. Replace the `SELECT ... FROM sms_outbox` statement with:

```ts
  const rows = db.prepare(`
    SELECT s.id, s.event_type AS eventType, s.to_phone AS toPhone, s.body, s.attempts, s.max_attempts AS maxAttempts, c.full_name AS clientName
    FROM sms_outbox s
    LEFT JOIN clients c ON c.id = s.client_id
    WHERE s.status='pending_dispatch' AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
    ORDER BY s.id ASC LIMIT 20
  `).all(nowIso) as Array<{
    id: number;
    eventType: SmsEventType | 'test';
    toPhone: string;
    body: string;
    attempts: number;
    maxAttempts: number;
    clientName: string | null;
  }>;
```

Update the `postRequest` call to pass `clientName`:

```ts
    const result = await deps.postRequest({ id: row.id, requestId, toPhone: row.toPhone, body: row.body, eventType: row.eventType, clientName: row.clientName });
```

Update the `SmsOutboxDeps.postRequest` signature and `defaultPostRequest` to carry `clientName`:

```ts
export type SmsOutboxDeps = {
  postRequest: (entry: { id: number; requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test'; clientName: string | null }) => Promise<SmsDispatchResult>;
  fetchStatus: (androidRequestId: string) => Promise<SmsStatusResult>;
};
```

```ts
async function defaultPostRequest(entry: { requestId: string; toPhone: string; body: string; eventType: SmsEventType | 'test'; clientName: string | null }): Promise<SmsDispatchResult> {
  try {
    const response = await signedFetch('/requests', 'POST', entry);
    const json = await readJson(response);
    if (!response.ok) return { ok: false, error: String(json.error || `Android recusou SMS (${response.status})`) };
    return { ok: true, androidRequestId: String(json.id || entry.requestId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Android companion offline' };
  }
}
```

- [ ] **Step 4: Run test + full backend suite**

Run:
```bash
npx.cmd vitest run src/backend/lib/sms-outbox.test.ts --no-file-parallelism
npm.cmd run typecheck
```
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/sms-outbox.ts src/backend/lib/sms-outbox.test.ts
git commit -m "feat(sms): include clientName in Android dispatch payload"
git push
```

---

## Task 10: Desktop — render the pairing QR in Settings

**Files:**
- Modify: `src/renderer/modules/SettingsModule.tsx`

- [ ] **Step 1: Track a QR data URL state**

In `SettingsModule`, near the other SMS state, add:

```tsx
  const [smsQrDataUrl, setSmsQrDataUrl] = useState<string>('');
```

Add the import at the top of the file:

```tsx
import QRCode from 'qrcode';
```

- [ ] **Step 2: Generate the QR when pairing succeeds**

In `createSmsPairing`, after the existing success `setMessage(...)` line that shows the `qrPayload`, add:

```tsx
      if (data.qrPayload) {
        try {
          const url = await QRCode.toDataURL(data.qrPayload, { width: 220, margin: 1 });
          setSmsQrDataUrl(url);
        } catch {
          setSmsQrDataUrl('');
        }
      }
```

- [ ] **Step 3: Render the QR image in the SMS pairing block**

In the SMS tab, inside the `<div className="settings-test-whatsapp" aria-label="Pareamento do Android SMS">` block, after the pairing action buttons (`<div className="form-actions">…</div>`), add:

```tsx
              {smsQrDataUrl && (
                <div className="sms-pairing-qr">
                  <img src={smsQrDataUrl} alt="QR Code de pareamento do Android SMS" width={220} height={220} />
                  <span>Lê este QR no app ISPM SMS do telemóvel para parear.</span>
                </div>
              )}
```

- [ ] **Step 4: Add minimal styling**

Append to `src/renderer/styles.css`:

```css
.sms-pairing-qr { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 12px; }
.sms-pairing-qr img { border-radius: 12px; background: #fff; padding: 8px; }
.sms-pairing-qr span { font-size: 0.8rem; color: var(--text-secondary, #9aa6b8); text-align: center; }
```

- [ ] **Step 5: Verify locally**

Run:
```bash
npm.cmd run typecheck
npm.cmd run lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/modules/SettingsModule.tsx src/renderer/styles.css
git commit -m "feat(sms): render pairing QR code in Settings SMS tab"
git push
```

---

## Self-Review notes

- **Spec coverage:** IA single-screen (Task 6), onboarding QR+manual (Task 7), permission banner (Tasks 5/6/8), status card + pending + history + empty (Tasks 5/6), undo window (Tasks 4/8), desktop QR (Task 10), desktop clientName (Task 9), tokens (Task 1), state model + mapping (Task 2), parse + undo tests (Tasks 3/4). Covered.
- **Type consistency:** `RequestUi`/`CompanionUiState`/`PairingSnapshot`/`buildUiState`/`PairingInfo`/`UndoController`/`CompanionStateHolder` signatures match across tasks; `SmsRequest` gains `clientName` in Task 2 and is read in Tasks 5/8 and written in Task 8's server change; desktop `SmsOutboxDeps.postRequest` gains `clientName` consistently (Task 9).
- **No backend protocol/schema change:** confirmed — `clientName` rides the existing POST body via a join; `sending` stays in-memory; status set unchanged.
- **Manual smoke (owed, needs phone):** pairing via QR and manual code; permission grant; approve + undo (5s); reject; empty state; dark rendering; verify desktop QR renders and Android scans it end-to-end.
