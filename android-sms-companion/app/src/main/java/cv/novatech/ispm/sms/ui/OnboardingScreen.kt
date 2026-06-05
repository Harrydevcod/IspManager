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
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import cv.novatech.ispm.sms.PortraitCaptureActivity
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.theme.AccentOrange
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextSecondary

@Composable
fun OnboardingScreen(onPaired: (PairingInfo) -> Unit, onInvalid: () -> Unit) {
  var showManual by remember { mutableStateOf(false) }

  val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
    val contents = result.contents
    if (contents == null) return@rememberLauncherForActivityResult
    val info = parsePairingPayload(contents)
    if (info != null) onPaired(info) else onInvalid()
  }

  Column(
    Modifier.fillMaxSize().padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center
  ) {
    Text("ISPM SMS", style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(8.dp))
    Text(
      "Para parear, lê o QR Code que aparece no ISPM (Configurações → SMS).",
      color = TextSecondary, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyMedium
    )
    Spacer(Modifier.height(24.dp))
    Button(
      onClick = {
        scanLauncher.launch(
          ScanOptions()
            .setOrientationLocked(false)
            .setBeepEnabled(false)
            .setPrompt("Aponta ao QR do ISPM")
            .setCaptureActivity(PortraitCaptureActivity::class.java)
        )
      },
      modifier = Modifier.fillMaxWidth()
    ) { Text("Ler QR Code") }
    Spacer(Modifier.height(10.dp))
    OutlinedButton(onClick = { showManual = true }, modifier = Modifier.fillMaxWidth()) {
      Text("Inserir código manualmente", color = TextSecondary)
    }
    Spacer(Modifier.height(16.dp))
    Text("A câmara é usada apenas para ler o código de pareamento.", color = TextMuted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
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
    Column(Modifier.padding(20.dp).fillMaxWidth()) {
      Text("Código de pareamento", style = MaterialTheme.typography.titleMedium)
      Spacer(Modifier.height(12.dp))
      OutlinedTextField(
        value = text, onValueChange = { text = it },
        placeholder = { Text("ispm-sms://pair?secret=…") },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions.Default
      )
      Spacer(Modifier.height(12.dp))
      Button(onClick = { onSubmit(text) }, enabled = text.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
        Text("Parear")
      }
      Spacer(Modifier.height(8.dp))
    }
  }
}
