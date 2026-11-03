package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.state.SimOption
import cv.novatech.ispm.sms.ui.theme.*

/** "SIM para enviar": only shown on dual-slot phones. Default = the phone's SMS SIM. */
@Composable
fun SimPicker(sims: List<SimOption>, selected: Int?, onRequestPhoneState: () -> Unit, onChoose: (Int?) -> Unit) {
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Text("SIM para enviar", color = TextPrimary, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(8.dp))
    if (sims.isEmpty()) {
      Text(
        "Escolher o SIM →", color = AccentBlue, style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.clickable { onRequestPhoneState() }
      )
      return@Column
    }
    SimRow("Predefinido do telemóvel", selected == null) { onChoose(null) }
    sims.forEach { sim -> SimRow(sim.label, selected == sim.subscriptionId) { onChoose(sim.subscriptionId) } }
  }
}

@Composable
private fun SimRow(label: String, active: Boolean, onClick: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
      .background(if (active) AccentBlue.copy(alpha = 0.14f) else SurfaceMuted)
      .clickable { onClick() }.padding(horizontal = 10.dp, vertical = 9.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Text(label, color = if (active) TextPrimary else TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
    if (active) Text("✓", color = AccentBlue, fontWeight = FontWeight.SemiBold)
  }
  Spacer(Modifier.height(6.dp))
}
