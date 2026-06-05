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
