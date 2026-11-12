package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.IspmSmsApp
import cv.novatech.ispm.sms.send.SimLimits
import cv.novatech.ispm.sms.ui.theme.*

/**
 * Ritmo de envio por SIM. Operators allow roughly 30–200 SMS per hour and may
 * block a SIM above that; "Prudente" is the default for that reason.
 */
@Composable
fun SendPaceSetting() {
  val store = (LocalContext.current.applicationContext as IspmSmsApp).settingsStore
  var pace by remember { mutableIntStateOf(store.simPace()) }
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Text("Ritmo de envio por SIM", color = TextPrimary, fontWeight = FontWeight.SemiBold)
    Text(
      "Acima disto, a operadora pode bloquear o cartão.",
      color = TextSecondary, style = MaterialTheme.typography.bodySmall
    )
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      SimLimits.PRESETS.forEachIndexed { i, (name, limits) ->
        FilterChip(
          selected = pace == i,
          onClick = { pace = i; store.setSimPace(i) },
          label = { Text("$name · ${limits.perHour}/h") }
        )
      }
    }
    Spacer(Modifier.height(6.dp))
    val chosen = SimLimits.PRESETS[pace].second
    Text("Até ${chosen.perHour} por hora e ${chosen.perDay} por dia em cada SIM.", color = TextMuted, style = MaterialTheme.typography.bodySmall)
  }
}
