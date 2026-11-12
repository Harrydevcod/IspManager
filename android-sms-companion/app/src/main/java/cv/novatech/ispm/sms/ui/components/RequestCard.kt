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
      // Waiting for a SIM with room still allows "Anular": nothing has reached the radio.
      val line = when (val until = req.waitUntil) {
        null -> "A enviar a ${req.clientName ?: req.toPhone}…"
        0L -> "Na fila: sai a seguir ao anterior"
        else -> "Aguarda o ritmo do SIM · sai às ${clock.format(java.util.Date(until))}"
      }
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(line, color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        TextButton(onClick = onUndo) { Text("Anular", color = AccentOrange, fontWeight = FontWeight.SemiBold) }
      }
    } else if (req.inFlight || req.status == "approved") {
      Text("A enviar… à espera da confirmação da rede", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
    } else {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
          onClick = onApprove, modifier = Modifier.weight(1f),
          colors = ButtonDefaults.buttonColors(containerColor = AccentBlue, contentColor = Bg)
        ) { Text("Aprovar e enviar") }
        OutlinedButton(onClick = onReject, modifier = Modifier.weight(1f)) { Text("Rejeitar", color = TextSecondary) }
      }
    }
  }
}

private val clock = java.text.SimpleDateFormat("HH:mm", java.util.Locale("pt", "PT"))
