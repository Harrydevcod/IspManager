package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.components.AppMark
import cv.novatech.ispm.sms.ui.components.ButtonVariant
import cv.novatech.ispm.sms.ui.components.IspmButton
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
    AppMark(64)
    Spacer(Modifier.height(20.dp))
    Text("ISPM SMS bloqueado", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Text(
      "Desbloqueie com a impressão digital ou o PIN.",
      color = TextMuted, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(24.dp))
    IspmButton("Desbloquear", onUnlock, Modifier.widthIn(min = 200.dp), ButtonVariant.PRIMARY, icon = Lucide.Lock)
  }
}
