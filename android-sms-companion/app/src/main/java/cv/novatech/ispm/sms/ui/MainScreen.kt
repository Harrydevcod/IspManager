package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.DesktopLink
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.state.ThemePref
import cv.novatech.ispm.sms.state.desktopLink
import cv.novatech.ispm.sms.ui.components.*
import cv.novatech.ispm.sms.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val screenPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 32.dp)

/** Pedidos: the approval queue. Banners stay here, where they block the work. */
@Composable
fun RequestsScreen(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onApprove: (String) -> Unit,
  onApproveAll: () -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit,
  onForgetPairing: () -> Unit,
  onRejectAll: () -> Unit = {}
) {
  val mismatch = desktopLink(state, rememberNow()) == DesktopLink.MISMATCH
  val approvable = state.pending.count { it.status == "pending_approval" && !it.sending }
  var confirmRejectAll by remember { mutableStateOf(false) }
  // Rejecting has no undo and the PC will not resend: ask once. Approving has its 5 s "Anular".
  if (confirmRejectAll) {
    AlertDialog(
      onDismissRequest = { confirmRejectAll = false },
      title = { Text("Rejeitar $approvable pedidos?") },
      text = { Text("Não serão enviados e o PC fica a saber. Os pedidos já aprovados continuam.") },
      confirmButton = {
        TextButton(onClick = { confirmRejectAll = false; onRejectAll() }) { Text("Rejeitar", color = Danger) }
      },
      dismissButton = { TextButton(onClick = { confirmRejectAll = false }) { Text("Cancelar", color = TextSecondary) } }
    )
  }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = screenPadding, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    item { ScreenTitle("Pedidos", if (state.pending.isEmpty()) null else "${state.pending.size} à espera de decisão") }
    // The desktop holds another secret: nothing reaches this queue until a new QR is read.
    if (mismatch) item { StatusCard(state, onForgetPairing) }
    if (!state.smsPermissionGranted) item { PermissionBanner(onRequestPermission) }
    if (!state.batteryExempt) item { BatteryBanner(onRequestBatteryExemption) }
    if (approvable >= 2) {
      item {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          IspmButton("Rejeitar todos", { confirmRejectAll = true }, Modifier.weight(1f), ButtonVariant.CRITICAL)
          IspmButton("Aprovar todos", onApproveAll, Modifier.weight(1f), ButtonVariant.SECONDARY)
        }
      }
    }
    if (state.pending.isEmpty()) {
      item { EmptyState(state.listenAddress) }
    } else {
      items(state.pending, key = { it.id }) { r ->
        RequestCard(
          r, onApprove = { onApprove(r.id) }, onReject = { onReject(r.id) }, onUndo = { onUndo(r.id) },
          modifier = Modifier.animateItem()
        )
      }
    }
  }
}

@Composable
fun HistoryScreen(state: CompanionUiState) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = screenPadding) {
    item { ScreenTitle("Histórico", "Últimos 30 dias") }
    if (state.history.isEmpty()) {
      item { Text("Ainda nada enviado.", color = TextMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 12.dp)) }
    }
    items(state.history, key = { "h-" + it.id }) { r ->
      Column(Modifier.animateItem()) {
        HistoryRow(r)
        Hairline()
      }
    }
  }
}

/** Definições: device-level things the operator sets once, grouped like the platform's own settings. */
@Composable
fun SettingsScreen(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onRequestPhoneState: () -> Unit,
  onChooseSim: (Int?) -> Unit,
  onForgetPairing: () -> Unit,
  onLockEnabledChange: (Boolean) -> Unit,
  themePref: ThemePref = ThemePref.SYSTEM,
  onThemeChange: (ThemePref) -> Unit = {}
) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = screenPadding) {
    item { ScreenTitle("Definições") }
    if (!state.smsPermissionGranted) item { Box(Modifier.padding(bottom = 10.dp)) { PermissionBanner(onRequestPermission) } }
    if (!state.batteryExempt) item { Box(Modifier.padding(bottom = 10.dp)) { BatteryBanner(onRequestBatteryExemption) } }
    item { SettingsSection("Ligação ao ISPM") { StatusCard(state, onForgetPairing) } }
    item {
      SettingsSection("Aparência") {
        SegmentedControl(ThemePref.entries, themePref, { it.label }, onThemeChange)
      }
    }
    item {
      SettingsSection("Segurança") {
        Group {
          GroupRow(
            "Bloquear a app",
            if (state.lockEnabled && !state.deviceSecure) "O telemóvel não tem PIN nem impressão digital. Defina um no Android." else null,
            detailColor = Warn
          ) { Switch(checked = state.lockEnabled, onCheckedChange = onLockEnabledChange) }
          CallerIdRow()
        }
      }
    }
    item { SettingsSection("Envio de SMS") { SendPaceSetting() } }
    if (state.dualSimCapable) {
      item { SettingsSection("SIM para enviar") { SimPicker(state.sims, state.selectedSim, onRequestPhoneState, onChooseSim) } }
    }
  }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
  Column(Modifier.fillMaxWidth().padding(top = 20.dp)) {
    SectionHeader(title)
    Spacer(Modifier.height(6.dp))
    content()
  }
}

@Composable
private fun BatteryBanner(onRequest: () -> Unit) =
  Banner("A otimização de bateria pode parar o envio", "Desativar", onRequest)

private val timeFormat = SimpleDateFormat("dd/MM HH:mm", Locale("pt", "PT"))

@Composable
private fun HistoryRow(r: RequestUi) {
  val (label, color) = when {
    r.status == "sent" && r.deliveredAt != null -> "Entregue" to Success
    r.status == "sent" -> "Enviado" to TextSecondary
    r.status == "rejected" -> "Rejeitado" to TextMuted
    else -> "Falhou" to Danger
  }
  Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Text(
        r.clientName ?: r.toPhone, color = TextPrimary, style = MaterialTheme.typography.bodyLarge,
        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
      )
      Spacer(Modifier.width(12.dp))
      Text(label, color = color, style = MaterialTheme.typography.labelMedium)
    }
    Row {
      Text(badgeFor(r.eventType).label, color = TextMuted, style = MaterialTheme.typography.labelSmall)
      r.updatedAt?.let { Text(" · ${timeFormat.format(Date(it))}", color = TextMuted, style = MaterialTheme.typography.labelSmall) }
    }
    if (r.status == "failed" && r.error != null) {
      Text(r.error, color = Danger, style = MaterialTheme.typography.bodySmall)
    }
  }
}
