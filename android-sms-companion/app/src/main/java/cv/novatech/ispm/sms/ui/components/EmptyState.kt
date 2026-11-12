package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

/** No SMS waiting: say so, and where the phone is listening (the thing to check if the PC can't reach it). */
@Composable
fun EmptyState(listenAddress: String) {
  Column(
    Modifier.fillMaxWidth().padding(vertical = 56.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Icon(Lucide.Check, contentDescription = null, tint = Success, modifier = Modifier.size(28.dp))
    Spacer(Modifier.height(12.dp))
    Text("Tudo em dia", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Text("À escuta em $listenAddress", color = TextMuted, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center)
  }
}
