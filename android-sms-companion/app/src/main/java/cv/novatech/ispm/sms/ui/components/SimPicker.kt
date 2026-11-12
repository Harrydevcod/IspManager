package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.SimOption
import cv.novatech.ispm.sms.send.SendBudget
import cv.novatech.ispm.sms.ui.theme.*

/** "SIM para enviar": only shown on dual-slot phones. Default = the phone's SMS SIM. A radio list inside a group. */
@Composable
fun SimPicker(sims: List<SimOption>, selected: Int?, onRequestPhoneState: () -> Unit, onChoose: (Int?) -> Unit) {
  Group {
    if (sims.isEmpty()) {
      GroupRow("Escolher o SIM", "O Android tem de mostrar os SIMs à app", onClick = onRequestPhoneState)
      return@Group
    }
    SimRow("Predefinido do telemóvel", selected == null) { onChoose(null) }
    sims.forEach { sim ->
      GroupDivider()
      SimRow(sim.label, selected == sim.subscriptionId) { onChoose(sim.subscriptionId) }
    }
    if (sims.size >= 2) {
      GroupDivider()
      SimRow("Alternar entre os SIMs", selected == SendBudget.ROTATE) { onChoose(SendBudget.ROTATE) }
    }
  }
}

@Composable
private fun SimRow(label: String, active: Boolean, onClick: () -> Unit) =
  GroupRow(label, onClick = onClick) {
    if (active) Icon(Lucide.Check, contentDescription = "Escolhido", tint = Accent, modifier = Modifier.size(20.dp))
  }
