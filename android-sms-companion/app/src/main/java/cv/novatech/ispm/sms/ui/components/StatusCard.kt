package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun StatusCard(deviceName: String, listenAddress: String, serverRunning: Boolean, permissionGranted: Boolean) {
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
      Text("Pareado · $deviceName", color = TextPrimary, fontWeight = FontWeight.SemiBold)
      LivePill(serverRunning)
    }
    Spacer(Modifier.height(6.dp))
    Text("A ouvir $listenAddress", color = TextSecondary, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
    Text(
      if (permissionGranted) "Permissão SMS ✓" else "Permissão SMS em falta",
      color = if (permissionGranted) Success else Warn,
      style = androidx.compose.material3.MaterialTheme.typography.bodySmall
    )
  }
}

@Composable
private fun LivePill(running: Boolean) {
  val c = if (running) Success else TextMuted
  Row(verticalAlignment = Alignment.CenterVertically) {
    Box(Modifier.size(6.dp).clip(CircleShape).background(c))
    Spacer(Modifier.width(5.dp))
    Text(if (running) "Ativo" else "Parado", color = c, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
  }
}
