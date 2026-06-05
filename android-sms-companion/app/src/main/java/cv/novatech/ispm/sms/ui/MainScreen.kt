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
