package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.events.FieldEvent
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.ThemePref
import cv.novatech.ispm.sms.ui.components.Hairline
import cv.novatech.ispm.sms.ui.dashboard.DashboardScreen
import cv.novatech.ispm.sms.ui.theme.*
import org.json.JSONObject

// The desktop's glyphs (lucide), one meaning each: requests are messages, history is the clock turning back.
enum class Tab(val label: String, val icon: ImageVector) {
  PAINEL("Painel", Lucide.LayoutDashboard),
  TERRENO("Terreno", Lucide.MapPin),
  PEDIDOS("Pedidos", Lucide.MessageSquare),
  HISTORICO("Histórico", Lucide.History),
  DEFINICOES("Ajustes", Lucide.Settings)
}

@Composable
fun CompanionApp(
  state: CompanionUiState,
  onPaired: (PairingInfo) -> Unit,
  onInvalidPairing: () -> Unit,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onRequestPhoneState: () -> Unit,
  onChooseSim: (Int?) -> Unit,
  onApprove: (String) -> Unit,
  onApproveAll: () -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit,
  onForgetPairing: () -> Unit,
  onOpen: (String) -> Unit,
  onLockEnabledChange: (Boolean) -> Unit,
  pendingEvents: List<FieldEvent> = emptyList(),
  onFieldEvent: (String, JSONObject, List<ByteArray>) -> Unit = { _, _, _ -> },
  onRejectAll: () -> Unit = {},
  onSync: () -> Unit = {},
  themePref: ThemePref = ThemePref.SYSTEM,
  onThemeChange: (ThemePref) -> Unit = {},
  onToggleTheme: (() -> Unit)? = null,
  initialTab: Tab? = null,
  onCancelPairing: () -> Unit = {}
) {
  Box(Modifier.fillMaxSize().background(Bg)) {
    // A v2 code on screen wins even over an old pairing (deep link while paired).
    if (!state.paired || state.pairingCode != null) {
      Box(Modifier.systemBarsPadding()) {
        OnboardingScreen(onPaired = onPaired, onInvalid = onInvalidPairing, pairingCode = state.pairingCode, onCancelPairing = onCancelPairing)
      }
    } else {
      PairedApp(
        state, onRequestPermission, onRequestBatteryExemption, onRequestPhoneState, onChooseSim,
        onApprove, onApproveAll, onUndo, onReject, onForgetPairing, onOpen, onLockEnabledChange,
        pendingEvents, onFieldEvent, onRejectAll, onSync, themePref, onThemeChange, onToggleTheme, initialTab
      )
    }
  }
}

@Composable
private fun PairedApp(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onRequestPhoneState: () -> Unit,
  onChooseSim: (Int?) -> Unit,
  onApprove: (String) -> Unit,
  onApproveAll: () -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit,
  onForgetPairing: () -> Unit,
  onOpen: (String) -> Unit,
  onLockEnabledChange: (Boolean) -> Unit,
  pendingEvents: List<FieldEvent>,
  onFieldEvent: (String, JSONObject, List<ByteArray>) -> Unit,
  onRejectAll: () -> Unit,
  onSync: () -> Unit,
  themePref: ThemePref,
  onThemeChange: (ThemePref) -> Unit,
  onToggleTheme: (() -> Unit)?,
  initialTab: Tab?
) {
  // Pending SMS outrank the overview: open on Pedidos when there is work waiting.
  var tab by rememberSaveable { mutableStateOf(initialTab ?: if (state.pending.isNotEmpty()) Tab.PEDIDOS else Tab.PAINEL) }
  Column(Modifier.fillMaxSize()) {
    Box(Modifier.weight(1f).fillMaxWidth().statusBarsPadding()) {
      when (tab) {
        Tab.PAINEL -> DashboardScreen(state.dashboard, state.dashboardReceivedAt, state.syncRequestedAt, onSync, onToggleTheme)
        Tab.TERRENO -> FieldScreen(state.dashboard, state.dashboardReceivedAt, onOpen, pendingEvents, onFieldEvent)
        Tab.PEDIDOS -> RequestsScreen(state, onRequestPermission, onRequestBatteryExemption, onApprove, onApproveAll, onUndo, onReject, onForgetPairing, onRejectAll)
        Tab.HISTORICO -> HistoryScreen(state)
        Tab.DEFINICOES -> SettingsScreen(
          state, onRequestPermission, onRequestBatteryExemption, onRequestPhoneState, onChooseSim, onForgetPairing,
          onLockEnabledChange, themePref, onThemeChange
        )
      }
    }
    Hairline()
    // Five tabs on a narrow phone (or a large system font): all labels share one
    // size, stepped down until the widest fits without wrapping.
    var labelScale by remember { mutableFloatStateOf(1f) }
    val labelSize = MaterialTheme.typography.labelSmall.fontSize * labelScale
    NavigationBar(containerColor = Surface, tonalElevation = 0.dp) {
      Tab.entries.forEach { t ->
        val count = if (t == Tab.PEDIDOS) state.pending.size else 0
        NavigationBarItem(
          selected = tab == t,
          onClick = { tab = t },
          icon = {
            val glyph: @Composable () -> Unit = { Icon(t.icon, contentDescription = null, modifier = Modifier.size(22.dp)) }
            if (count > 0) {
              BadgedBox(badge = { Badge(containerColor = Accent, contentColor = OnAccent) { Text(count.toString()) } }) { glyph() }
            } else {
              glyph()
            }
          },
          label = {
            Text(
              t.label,
              style = MaterialTheme.typography.labelSmall,
              fontSize = labelSize,
              maxLines = 1,
              softWrap = false,
              onTextLayout = { if (it.didOverflowWidth && labelScale > 0.7f) labelScale -= 0.05f }
            )
          },
          colors = NavigationBarItemDefaults.colors(
            selectedIconColor = TextPrimary,
            selectedTextColor = TextPrimary,
            indicatorColor = Surface3,
            unselectedIconColor = TextMuted,
            unselectedTextColor = TextMuted
          )
        )
      }
    }
  }
}
