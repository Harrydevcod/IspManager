package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
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

// Seconds on purpose: "visto há 12 s" is the liveness the operator checks here.
private fun ago(ms: Long): String {
  val s = (ms / 1000).coerceAtLeast(0)
  return if (s < 60) "há $s s" else "há ${s / 60} min"
}

/** The link to the PC, as a group of facts; the way out (forget and re-pair) under it. */
@Composable
fun StatusCard(state: CompanionUiState, onForget: () -> Unit) {
  val now = rememberNow()
  val (line, tone) = when (desktopLink(state, now)) {
    DesktopLink.LINKED -> "Ligado ao ISPM · visto ${ago(now - (state.lastDesktopAt ?: now))}" to Success
    DesktopLink.MISMATCH -> "O ISPM usa outro pareamento. Esqueça este e leia o QR novo." to Warn
    DesktopLink.WAITING -> "À espera do ISPM. Confirme que o PC está na mesma rede Wi-Fi." to TextMuted
  }
  Column {
    Group {
      GroupRow(state.deviceName.ifBlank { "Este telemóvel" }, line, detailColor = tone) { StatusDot(tone) }
      GroupDivider()
      GroupRow(
        "Servidor",
        if (state.serverRunning) "A ouvir ${state.listenAddress}" else "Parado. Reabra a app.",
        detailColor = if (state.serverRunning) TextMuted else Warn
      )
      GroupDivider()
      GroupRow("Permissão de SMS") {
        Text(
          if (state.smsPermissionGranted) "Concedida" else "Em falta",
          color = if (state.smsPermissionGranted) Success else Warn, style = MaterialTheme.typography.labelMedium
        )
      }
    }
    Spacer(Modifier.height(10.dp))
    ForgetPairingButton(onForget)
  }
}

/** Leaves the pairing so a new QR can be read. Destructive: always confirmed. */
@Composable
fun ForgetPairingButton(onForget: () -> Unit) {
  var confirm by remember { mutableStateOf(false) }
  IspmButton("Esquecer e parear de novo", { confirm = true }, Modifier.fillMaxWidth(), ButtonVariant.CRITICAL)
  if (confirm) {
    AlertDialog(
      onDismissRequest = { confirm = false },
      title = { Text("Esquecer este pareamento?") },
      text = { Text("O ISPM deixa de conseguir enviar SMS por este telemóvel até ler um QR novo. Os pedidos e o histórico ficam.") },
      confirmButton = {
        TextButton(onClick = { confirm = false; onForget() }) { Text("Esquecer", color = Danger) }
      },
      dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancelar", color = TextSecondary) } }
    )
  }
}
