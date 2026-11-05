package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.ui.dashboard.DashboardScreen
import cv.novatech.ispm.sms.ui.theme.AccentBlue
import cv.novatech.ispm.sms.ui.theme.Bg
import cv.novatech.ispm.sms.ui.theme.SurfaceMuted
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextPrimary

private enum class Tab(val label: String, val icon: ImageVector) {
  PAINEL("Painel", Icons.Filled.Home),
  PEDIDOS("Pedidos", Icons.Filled.Email),
  HISTORICO("Histórico", Icons.Filled.DateRange),
  DEFINICOES("Definições", Icons.Filled.Settings)
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
  onForgetPairing: () -> Unit
) {
  Surface(Modifier.fillMaxSize().background(Bg)) {
    if (!state.paired) {
      OnboardingScreen(onPaired = onPaired, onInvalid = onInvalidPairing)
    } else {
      PairedApp(
        state, onRequestPermission, onRequestBatteryExemption, onRequestPhoneState, onChooseSim,
        onApprove, onApproveAll, onUndo, onReject, onForgetPairing
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
  onForgetPairing: () -> Unit
) {
  // Pending SMS outrank the overview: open on Pedidos when there is work waiting.
  var tab by rememberSaveable { mutableStateOf(if (state.pending.isNotEmpty()) Tab.PEDIDOS else Tab.PAINEL) }
  Column(Modifier.fillMaxSize()) {
    Box(Modifier.weight(1f).fillMaxWidth()) {
      when (tab) {
        Tab.PAINEL -> DashboardScreen(state.dashboard, state.dashboardReceivedAt)
        Tab.PEDIDOS -> RequestsScreen(state, onRequestPermission, onRequestBatteryExemption, onApprove, onApproveAll, onUndo, onReject, onForgetPairing)
        Tab.HISTORICO -> HistoryScreen(state)
        Tab.DEFINICOES -> SettingsScreen(state, onRequestPermission, onRequestBatteryExemption, onRequestPhoneState, onChooseSim, onForgetPairing)
      }
    }
    NavigationBar(containerColor = SurfaceMuted) {
      Tab.entries.forEach { t ->
        val count = if (t == Tab.PEDIDOS) state.pending.size else 0
        NavigationBarItem(
          selected = tab == t,
          onClick = { tab = t },
          icon = {
            if (count > 0) {
              BadgedBox(badge = { Badge { Text(count.toString()) } }) { Icon(t.icon, contentDescription = t.label) }
            } else {
              Icon(t.icon, contentDescription = t.label)
            }
          },
          label = { Text(t.label) },
          colors = NavigationBarItemDefaults.colors(
            selectedIconColor = TextPrimary,
            selectedTextColor = TextPrimary,
            indicatorColor = AccentBlue.copy(alpha = 0.22f),
            unselectedIconColor = TextMuted,
            unselectedTextColor = TextMuted
          )
        )
      }
    }
  }
}
