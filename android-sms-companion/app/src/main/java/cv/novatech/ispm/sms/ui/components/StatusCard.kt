package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.CompanionUiState
import cv.novatech.ispm.sms.state.DesktopLink
import cv.novatech.ispm.sms.state.desktopLink
import cv.novatech.ispm.sms.ui.theme.*
import kotlinx.coroutines.delay

/** Clock that ticks every 15 s so "visto há" and the link state age without new events. */
@Composable
fun rememberNow(): Long {
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) { delay(15_000); now = System.currentTimeMillis() }
  }
  return now
}

private fun ago(ms: Long): String {
  val s = (ms / 1000).coerceAtLeast(0)
  return if (s < 60) "há $s s" else "há ${s / 60} min"
}

@Composable
fun StatusCard(state: CompanionUiState, onForget: () -> Unit) {
  val now = rememberNow()
  val link = desktopLink(state, now)
  val (label, color) = when (link) {
    DesktopLink.LINKED -> "Ligado ao ISPM · visto ${ago(now - (state.lastDesktopAt ?: now))}" to Success
    DesktopLink.MISMATCH -> "O ISPM usa outro pareamento" to Warn
    DesktopLink.WAITING -> "À espera do ISPM" to TextMuted
  }
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Text("Pareado · ${state.deviceName}", color = TextPrimary, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
      Dot(color)
      Spacer(Modifier.width(6.dp))
      Text(label, color = color, style = MaterialTheme.typography.bodySmall)
    }
    if (link == DesktopLink.MISMATCH) {
      Text(
        "Esqueça este pareamento e leia o QR novo do ISPM.",
        color = TextSecondary, style = MaterialTheme.typography.bodySmall
      )
    } else if (link == DesktopLink.WAITING) {
      Text(
        "Confirme que o PC está na mesma rede Wi-Fi.",
        color = TextSecondary, style = MaterialTheme.typography.bodySmall
      )
    }
    Spacer(Modifier.height(6.dp))
    Text(
      if (state.serverRunning) "A ouvir ${state.listenAddress}" else "Servidor parado. Reabra a app.",
      color = if (state.serverRunning) TextSecondary else Warn,
      style = MaterialTheme.typography.bodySmall
    )
    Text(
      if (state.smsPermissionGranted) "Permissão SMS ✓" else "Permissão SMS em falta",
      color = if (state.smsPermissionGranted) Success else Warn,
      style = MaterialTheme.typography.bodySmall
    )
    Spacer(Modifier.height(12.dp))
    ForgetPairingButton(onForget)
  }
}

/** Leaves the pairing so a new QR can be read. Destructive: always confirmed. */
@Composable
fun ForgetPairingButton(onForget: () -> Unit) {
  var confirm by remember { mutableStateOf(false) }
  OutlinedButton(
    onClick = { confirm = true },
    colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger),
    modifier = Modifier.fillMaxWidth()
  ) { Text("Esquecer e parear de novo") }
  if (confirm) {
    AlertDialog(
      onDismissRequest = { confirm = false },
      title = { Text("Esquecer este pareamento?") },
      text = { Text("O ISPM deixa de conseguir enviar SMS por este telemóvel até ler um QR novo. Os pedidos e o histórico ficam.") },
      confirmButton = {
        TextButton(onClick = { confirm = false; onForget() }) { Text("Esquecer", color = Danger) }
      },
      dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancelar") } }
    )
  }
}

@Composable
private fun Dot(c: Color) = Box(Modifier.size(6.dp).clip(CircleShape).background(c))
