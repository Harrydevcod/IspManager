package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.RequestUi
import cv.novatech.ispm.sms.ui.theme.*

/** One SMS waiting for a decision: who, what kind, the message itself, then the two choices. */
@Composable
fun RequestCard(req: RequestUi, onApprove: () -> Unit, onReject: () -> Unit, onUndo: () -> Unit, modifier: Modifier = Modifier) {
  val badge = badgeFor(req.eventType)
  Column(
    modifier.fillMaxWidth()
      .clip(MaterialTheme.shapes.medium).background(Surface)
      .border(1.dp, BorderC, MaterialTheme.shapes.medium)
      .padding(16.dp)
  ) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Text(
        req.clientName ?: req.toPhone, color = TextPrimary, style = MaterialTheme.typography.titleSmall,
        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
      )
      Spacer(Modifier.width(10.dp))
      Text(
        badge.label, color = badge.fg, style = MaterialTheme.typography.labelSmall,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(badge.bg).padding(horizontal = 8.dp, vertical = 3.dp)
      )
    }
    if (req.clientName != null) Text(req.toPhone, color = TextMuted, style = MaterialTheme.typography.labelMedium)
    Spacer(Modifier.height(10.dp))
    // The message as it will arrive; no box inside the card.
    Text(req.body, color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(14.dp))
    if (req.sending) {
      // Waiting for a SIM with room still allows "Anular": nothing has reached the radio.
      val line = when (val until = req.waitUntil) {
        null -> "A enviar…"
        0L -> "Na fila: sai a seguir ao anterior"
        else -> "Aguarda o ritmo do SIM · sai às ${clock.format(java.util.Date(until))}"
      }
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(line, color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        IspmButton("Anular", onUndo, variant = ButtonVariant.SECONDARY)
      }
    } else if (req.inFlight || req.status == "approved") {
      Text("A enviar… à espera da confirmação da rede", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
    } else {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        IspmButton("Rejeitar", onReject, Modifier.weight(1f), ButtonVariant.CRITICAL)
        IspmButton("Aprovar", onApprove, Modifier.weight(1f), ButtonVariant.PRIMARY)
      }
    }
  }
}

private val clock = java.text.SimpleDateFormat("HH:mm", java.util.Locale("pt", "PT"))
