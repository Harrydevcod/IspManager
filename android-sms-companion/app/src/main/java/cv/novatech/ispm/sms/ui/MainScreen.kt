package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.ui.components.*
import cv.novatech.ispm.sms.ui.theme.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun MainScreen(
  state: CompanionUiState,
  onRequestPermission: () -> Unit,
  onRequestBatteryExemption: () -> Unit,
  onRequestPhoneState: () -> Unit,
  onChooseSim: (Int?) -> Unit,
  onApprove: (String) -> Unit,
  onApproveAll: () -> Unit,
  onUndo: (String) -> Unit,
  onReject: (String) -> Unit
) {
  val approvable = state.pending.count { it.status == "pending_approval" && !it.sending }
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Text("ISPM SMS", style = MaterialTheme.typography.titleLarge) }
    if (!state.smsPermissionGranted) item { PermissionBanner(onRequestPermission) }
    if (!state.batteryExempt) {
      item {
        PermissionBanner(
          onRequest = onRequestBatteryExemption,
          title = "Otimização de bateria ativa",
          action = "Desativar →"
        )
      }
    }
    item { StatusCard(state.deviceName, state.listenAddress, state.serverRunning, state.smsPermissionGranted) }
    if (state.dualSimCapable) {
      item { SimPicker(state.sims, state.selectedSim, onRequestPhoneState, onChooseSim) }
    }

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

    if (state.history.isNotEmpty()) {
      item { SectionLabel("Histórico · últimos 30 dias") }
      items(state.history, key = { "h-" + it.id }) { r -> HistoryRow(r) }
    }
  }
}

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
  Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp)) {
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
