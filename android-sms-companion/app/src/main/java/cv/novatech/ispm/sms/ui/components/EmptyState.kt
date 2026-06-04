package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextSecondary

@Composable
fun EmptyState(listenAddress: String) {
  Column(
    Modifier.fillMaxWidth().padding(vertical = 48.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("Tudo em dia", color = TextSecondary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(4.dp))
    Text("À escuta em $listenAddress", color = TextMuted, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
  }
}
