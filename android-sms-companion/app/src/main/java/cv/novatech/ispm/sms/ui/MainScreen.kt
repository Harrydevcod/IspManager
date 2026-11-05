package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.DesktopLink
import cv.novatech.ispm.sms.state.desktopLink
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.ui.components.*
import cv.novatech.ispm.sms.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
  onForgetPairing: () -> Unit
) {
  val mismatch = desktopLink(state, rememberNow()) == DesktopLink.MISMATCH
  val approvable = state.pending.count { it.status == "pending_approval" && !it.sending }
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Text("Pedidos", style = MaterialTheme.typography.titleLarge) }
    // The desktop holds another secret: nothing reaches this queue until a new QR is read.
    if (mismatch) item { StatusCard(state, onForgetPairing) }
    if (!state.smsPermissionGranted) item { PermissionBanner(onRequestPermission) }
    if (!state.batteryExempt) item { BatteryBanner(onRequestBatteryExemption) }

    item {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        SectionLabel("Pendentes · ${state.pending.size}")
        if (approvable >= 2) {
          TextButton(onClick = onApproveAll) {
            Text("Aprovar todos", color = AccentBlue, fontWeight = FontWeight.SemiBold)
          }
        }
      }
    }
    if (state.pending.isEmpty()) {
      item { EmptyState(state.listenAddress) }
    } else {
      items(state.pending, key = { it.id }) { r ->
        RequestCard(r, onApprove = { onApprove(r.id) }, onReject = { onReject(r.id) }, onUndo = { onUndo(r.id) })
      }
    }
  }
}

@Composable
fun HistoryScreen(state: CompanionUiState) {
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Text("Histórico", style = MaterialTheme.typography.titleLarge) }
    item { SectionLabel("Últimos 30 dias") }
    if (state.history.isEmpty()) {
      item {
        Text("Ainda nada enviado.", color = TextMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(4.dp))
      }
    }
    items(state.history, key = { "h-" + it.id }) { r -> HistoryRow(r) }
  }
}

/** Definições: device-level things the operator sets once. */
@Composable
fun SettingsScreen(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onRequestPhoneState: () -> Unit,
  onChooseSim: (Int?) -> Unit,
  onForgetPairing: () -> Unit,
  onLockEnabledChange: (Boolean) -> Unit
) {
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Text("Definições", style = MaterialTheme.typography.titleLarge) }
    item { StatusCard(state, onForgetPairing) }
    if (!state.smsPermissionGranted) item { PermissionBanner(onRequestPermission) }
    if (!state.batteryExempt) item { BatteryBanner(onRequestBatteryExemption) }
    item { LockSetting(state.lockEnabled, state.deviceSecure, onLockEnabledChange) }
    item { CallerIdSetting() }
    if (state.dualSimCapable) {
      item { SimPicker(state.sims, state.selectedSim, onRequestPhoneState, onChooseSim) }
    }
  }
}

@Composable
private fun LockSetting(enabled: Boolean, deviceSecure: Boolean, onChange: (Boolean) -> Unit) {
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Bloquear a app", color = TextPrimary, fontWeight = FontWeight.SemiBold)
        Text(
          "Pede a impressão digital ou o PIN ao abrir e depois de 2 min fora. Esconde os dados nas apps recentes.",
          color = TextSecondary, style = MaterialTheme.typography.bodySmall
        )
      }
      Spacer(Modifier.width(12.dp))
      Switch(checked = enabled, onCheckedChange = onChange)
    }
    if (enabled && !deviceSecure) {
      Spacer(Modifier.height(8.dp))
      Text(
        "O telemóvel não tem PIN nem impressão digital: defina um nas definições do Android para a app poder bloquear.",
        color = Warn, style = MaterialTheme.typography.bodySmall
      )
    }
  }
}

@Composable
private fun BatteryBanner(onRequest: () -> Unit) =
  PermissionBanner(onRequest = onRequest, title = "Otimização de bateria ativa", action = "Desativar →")

@Composable
private fun SectionLabel(text: String) {
  Text(text, color = TextMuted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp, start = 4.dp))
}

private val timeFormat = SimpleDateFormat("dd/MM HH:mm", Locale("pt", "PT"))

@Composable
private fun HistoryRow(r: RequestUi) {
  val (label, color) = when {
    r.status == "sent" && r.deliveredAt != null -> "entregue" to Success
    r.status == "sent" -> "enviado" to TextSecondary
    r.status == "rejected" -> "rejeitado" to TextMuted
    else -> "falhou" to Danger
  }
  Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
      Text(
        r.clientName ?: r.toPhone, color = TextSecondary, style = MaterialTheme.typography.bodySmall,
        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
      )
      Spacer(Modifier.width(8.dp))
      r.updatedAt?.let { Text(timeFormat.format(Date(it)), color = TextMuted, style = MaterialTheme.typography.labelSmall) }
      Spacer(Modifier.width(8.dp))
      Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
    if (r.status == "failed" && r.error != null) {
      Text(r.error, color = TextMuted, style = MaterialTheme.typography.labelSmall)
    }
  }
}
