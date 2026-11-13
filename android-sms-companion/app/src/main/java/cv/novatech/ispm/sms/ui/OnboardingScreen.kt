package cv.novatech.ispm.sms.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import cv.novatech.ispm.sms.PortraitCaptureActivity
import cv.novatech.ispm.sms.state.PairingCode
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.components.AppMark
import cv.novatech.ispm.sms.ui.components.ButtonVariant
import cv.novatech.ispm.sms.ui.components.IspmButton
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun OnboardingScreen(
  onPaired: (PairingInfo) -> Unit,
  onInvalid: () -> Unit,
  pairingCode: PairingCode? = null,
  onConfirmPairing: () -> Unit = {},
  onCancelPairing: () -> Unit = {}
) {
  if (pairingCode != null) {
    PairingCodeScreen(pairingCode, onConfirmPairing, onCancelPairing)
    return
  }
  var showManual by remember { mutableStateOf(false) }

  val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
    val contents = result.contents
    if (contents == null) return@rememberLauncherForActivityResult
    val info = parsePairingPayload(contents)
    if (info != null) onPaired(info) else onInvalid()
  }

  Column(
    Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 32.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center
  ) {
    AppMark()
    Spacer(Modifier.height(24.dp))
    Text("ISPM SMS", color = TextPrimary, style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(6.dp))
    Text(
      "Leia o QR do ISPM no PC, em Definições › SMS.",
      color = TextSecondary, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium
    )
    Spacer(Modifier.height(28.dp))
    IspmButton(
      "Ler QR Code",
      onClick = {
        scanLauncher.launch(
          ScanOptions()
            .setOrientationLocked(false)
            .setBeepEnabled(false)
            .setPrompt("Aponte ao QR do ISPM")
            .setCaptureActivity(PortraitCaptureActivity::class.java)
        )
      },
      modifier = Modifier.fillMaxWidth(), variant = ButtonVariant.PRIMARY, icon = Lucide.QrCode
    )
    Spacer(Modifier.height(10.dp))
    IspmButton("Inserir código manualmente", { showManual = true }, Modifier.fillMaxWidth(), ButtonVariant.SECONDARY)
    Spacer(Modifier.height(16.dp))
    Text("A câmara só lê o código de pareamento.", color = TextMuted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
  }

  if (showManual) {
    ManualPairSheet(
      onDismiss = { showManual = false },
      onSubmit = { raw ->
        val info = parsePairingPayload(raw)
        showManual = false
        if (info != null) onPaired(info) else onInvalid()
      }
    )
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManualPairSheet(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
  var text by remember { mutableStateOf("") }
  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("Código de pareamento", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
      OutlinedTextField(
        value = text, onValueChange = { text = it },
        placeholder = { Text("ispm-sms://pair?…") },
        singleLine = true, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions.Default
      )
      IspmButton("Parear", { onSubmit(text) }, Modifier.fillMaxWidth(), ButtonVariant.PRIMARY, enabled = text.isNotBlank())
    }
  }
}

/** ADR 0023: the PC shows the same six digits; the operator confirms on both screens. */
@Composable
private fun PairingCodeScreen(code: PairingCode, onConfirm: () -> Unit, onCancel: () -> Unit) {
  Column(
    Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 32.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center
  ) {
    Text(if (code.confirmedOnPhone) "Confirme no computador" else "O computador mostra o mesmo código?", color = TextPrimary, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    Spacer(Modifier.height(6.dp))
    Text(code.desktopName, color = TextSecondary, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
    Spacer(Modifier.height(28.dp))
    Text(
      "${code.sas.take(3)} ${code.sas.drop(3)}",
      color = TextPrimary,
      style = MaterialTheme.typography.headlineLarge.copy(fontSize = 44.sp, lineHeight = 52.sp, letterSpacing = 2.sp)
    )
    Spacer(Modifier.height(28.dp))
    if (code.confirmedOnPhone) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(16.dp), color = TextMuted, strokeWidth = 2.dp)
        Text("À espera do computador", color = TextMuted, style = MaterialTheme.typography.bodySmall)
      }
      Spacer(Modifier.height(28.dp))
      IspmButton("Cancelar", onCancel, Modifier.fillMaxWidth(), ButtonVariant.SECONDARY)
    } else {
      IspmButton("Coincide", onConfirm, Modifier.fillMaxWidth(), ButtonVariant.PRIMARY)
      Spacer(Modifier.height(10.dp))
      IspmButton("Não coincide", onCancel, Modifier.fillMaxWidth(), ButtonVariant.CRITICAL)
    }
  }
}
