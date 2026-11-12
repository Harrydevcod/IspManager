package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

/** Covers every screen while locked; asks once on its own, then on the button. */
@Composable
fun LockScreen(onUnlock: () -> Unit) {
  LaunchedEffect(Unit) { onUnlock() }
  Column(
    Modifier.fillMaxSize().background(Bg).padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Icon(Icons.Filled.Lock, contentDescription = null, tint = TextMuted, modifier = Modifier.size(40.dp))
    Spacer(Modifier.height(16.dp))
    Text("ISPM SMS bloqueado", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(6.dp))
    Text(
      "Desbloqueie com a impressão digital ou o PIN.",
      color = TextMuted, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(24.dp))
    Button(onClick = onUnlock, colors = ButtonDefaults.buttonColors(containerColor = AccentBlue)) { Text("Desbloquear") }
  }
}
