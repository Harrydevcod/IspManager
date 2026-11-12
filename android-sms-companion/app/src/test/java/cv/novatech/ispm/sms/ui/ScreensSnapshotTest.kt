package cv.novatech.ispm.sms.ui

import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityOptionsCompat
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.state.SyncRules
import cv.novatech.ispm.sms.ui.components.StatusCard
import cv.novatech.ispm.sms.ui.dashboard.DashboardScreen
import cv.novatech.ispm.sms.ui.theme.Bg
import cv.novatech.ispm.sms.ui.theme.IspmTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * The visual smoke of the phone app: every screen and state the owner must see
 * before a merge, drawn on the JVM (no phone, no emulator). CI uploads the PNGs
 * as the `ispm-sms-companion-screens` artifact. Nothing is compared yet: the
 * point is to look at them.
 */
@RunWith(Parameterized::class)
class ScreensSnapshotTest(private val label: String, device: DeviceConfig) {
  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0}")
    fun devices() = listOf(
      arrayOf("pixel5", DeviceConfig.PIXEL_5),
      arrayOf("pequeno-360dp", DeviceConfig.NEXUS_5),
      arrayOf("letra-grande", DeviceConfig.PIXEL_5.copy(fontScale = 1.3f))
    )
  }

  @get:Rule
  val paparazzi = Paparazzi(deviceConfig = device, theme = "android:Theme.Material.NoActionBar")

  private val now = System.currentTimeMillis()

  private fun shot(name: String, content: @Composable () -> Unit) =
    paparazzi.snapshot(name = "$label-$name") {
      IspmTheme { Surface(Modifier.fillMaxSize(), color = Bg) { content() } }
    }

  // Shape produced by src/backend/lib/companion-snapshot.ts (schemaVersion 1), with the Terreno fields.
  private val dashboard = Dashboard.parse(
    """
    {"schemaVersion":1,"generatedAt":"2026-11-12T12:00:00.000Z","companyName":"Novatech",
     "operation":{"severity":"amber","headline":"2 antenas em baixo",
       "risks":[{"title":"Antena Monte Sossego","detail":"caiu 4 vezes hoje","severity":"red","exposureCve":null}],
       "actions":[{"title":"Visitar a antena","detail":"","severity":"amber","horizon":"now"}]},
     "money":{"paidMonthCve":152500,"paidPrevMonthCve":131000,"pendingMonthCve":45000,"pendingMonthCount":18,
       "pendingPreviousCve":30000,"overduePayments":9,
       "criticalOverdue":[{"clientName":"Ana Lopes Fonseca dos Santos","amountCve":2750,"daysOverdue":41}],
       "debtors":[{"clientName":"Ana Lopes","clientCode":"C1","phone":"+2389912233","amountCve":5000,"daysOverdue":41}],
       "cashToday":{"totalCve":12500,"byAccount":[{"name":"Caixa loja","amountCve":7500},{"name":"BCA","amountCve":5000}]},
       "monthlyReceipts":[{"month":"2026-06","amountCve":118000},{"month":"2026-07","amountCve":124500},{"month":"2026-08","amountCve":131000},
         {"month":"2026-09","amountCve":127250},{"month":"2026-10","amountCve":129000},{"month":"2026-11","amountCve":40500}]},
     "network":{"tone":"warn","probeEnabled":true,"lastProbeAt":null,"downCount":2,
       "downNow":[{"kind":"assignment","id":7,"name":"Antena Monte Sossego","since":"2026-11-12T11:00:00Z"},
         {"kind":"assignment","id":8,"name":"CPE Ribeira Bote","since":"2026-11-12T11:20:00Z"}],"findingsCount":3,
       "wans":[{"name":"starlink1","running":true,"downBps":25000000,"upBps":4000000},{"name":"starlink2","running":false,"downBps":null,"upBps":null}],"wanReason":null},
     "work":{"orders":[],"tickets":[]},
     "customers":{"total":60,"active":52,"suspended":5,"openWorkOrders":2,"openTickets":1},
     "sms":{"today":{"sent":4,"delivered":3,"failed":1,"pending":2},"month":{"sent":80,"delivered":70,"failed":5,"pending":2}}}
    """.trimIndent()
  )!!

  @Test fun painel() {
    shot("painel-com-dados") { DashboardScreen(dashboard, now - 2 * 60_000) }
    shot("painel-desatualizado") { DashboardScreen(dashboard, now - 40 * 60_000) }
    shot("painel-a-sincronizar") { DashboardScreen(dashboard, now - 6 * 60_000, syncRequestedAt = now - 10_000) }
    shot("painel-sem-resposta") { DashboardScreen(dashboard, now - 9 * 60_000, syncRequestedAt = now - SyncRules.WAIT_MS - 1) }
  }

  @Test fun painelVazio() {
    shot("painel-vazio") { DashboardScreen(null, null) }
    shot("painel-vazio-a-sincronizar") { DashboardScreen(null, null, syncRequestedAt = now - 10_000) }
    shot("painel-vazio-sem-resposta") { DashboardScreen(null, null, syncRequestedAt = now - SyncRules.WAIT_MS - 1) }
  }

  private val paired = CompanionUiState(
    paired = true, deviceName = "Telemóvel da loja", listenAddress = "192.168.1.50:8765",
    serverRunning = true, smsPermissionGranted = true
  )

  @Test fun ligacao() {
    shot("ligacao-ligado") { Box(Modifier.padding(16.dp)) { StatusCard(paired.copy(lastDesktopAt = now - 20_000)) {} } }
    shot("ligacao-a-espera") { Box(Modifier.padding(16.dp)) { StatusCard(paired) {} } }
    shot("ligacao-outro-pareamento") { Box(Modifier.padding(16.dp)) { StatusCard(paired.copy(lastRejectedAt = now - 20_000)) {} } }
  }

  private fun req(id: String, name: String?, event: String, sending: Boolean = false) = RequestUi(
    id = id, clientName = name, toPhone = "+2389912233", eventType = event,
    body = "Caro cliente, a fatura de novembro de 2.750\$00 vence a 10. Novatech", status = "pending_approval",
    error = null, sending = sending, updatedAt = now
  )

  @Test fun pedidos() {
    val pending = listOf(
      req("1", "Ana Lopes Fonseca dos Santos", "payment_overdue"),
      req("2", null, "receipt_confirmed"),
      req("3", "Rui Monteiro", "invoice_issued", sending = true)
    )
    shot("pedidos-com-fila") { RequestsScreen(paired.copy(pending = pending, lastDesktopAt = now), {}, {}, {}, {}, {}, {}, {}) }
    shot("pedidos-vazio") { RequestsScreen(paired.copy(lastDesktopAt = now), {}, {}, {}, {}, {}, {}, {}) }
    shot("pedidos-sem-permissao") { RequestsScreen(paired.copy(smsPermissionGranted = false, batteryExempt = false), {}, {}, {}, {}, {}, {}, {}) }
  }

  // The QR launcher needs a registry; nothing is launched in a snapshot.
  private val registryOwner = object : ActivityResultRegistryOwner {
    override val activityResultRegistry = object : ActivityResultRegistry() {
      override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) = Unit
    }
  }

  @Test fun entrada() {
    shot("pareamento") {
      CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) { OnboardingScreen({}, {}) }
    }
    shot("bloqueio") { LockScreen {} }
  }
}
