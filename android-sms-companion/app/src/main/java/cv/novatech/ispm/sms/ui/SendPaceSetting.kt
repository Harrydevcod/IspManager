package cv.novatech.ispm.sms.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.IspmSmsApp
import cv.novatech.ispm.sms.send.SimLimits
import cv.novatech.ispm.sms.ui.components.SegmentedControl
import cv.novatech.ispm.sms.ui.theme.*

/**
 * Ritmo de envio por SIM. Operators allow roughly 30–200 SMS per hour and may
 * block a SIM above that; "Prudente" is the default for that reason.
 */
@Composable
fun SendPaceSetting() {
  // ponytail: null only off-device (the screen snapshots); hoist the pace into the state if a third caller appears.
  val store = (LocalContext.current.applicationContext as? IspmSmsApp)?.settingsStore
  var pace by remember { mutableIntStateOf(store?.simPace() ?: 0) }
  SegmentedControl(SimLimits.PRESETS.indices.toList(), pace, { SimLimits.PRESETS[it].first }, { pace = it; store?.setSimPace(it) })
  Spacer(Modifier.height(8.dp))
  val chosen = SimLimits.PRESETS[pace].second
  Text(
    "Até ${chosen.perHour} por hora e ${chosen.perDay} por dia em cada SIM. Acima disto, a operadora pode bloquear o cartão.",
    color = TextMuted, style = MaterialTheme.typography.bodySmall
  )
}
