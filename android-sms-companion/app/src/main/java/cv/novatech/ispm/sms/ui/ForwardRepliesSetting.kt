package cv.novatech.ispm.sms.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import cv.novatech.ispm.sms.IspmSmsApp
import cv.novatech.ispm.sms.ui.theme.*

/**
 * "Reencaminhar respostas dos clientes": on only with the operator's choice and
 * Android's RECEIVE_SMS. The switch shows both: on = chosen and allowed.
 */
@Composable
fun ForwardRepliesSetting() {
  val context = LocalContext.current
  val store = (context.applicationContext as IspmSmsApp).settingsStore
  fun allowed() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
  var on by remember { mutableStateOf(store.forwardReplies() && allowed()) }
  val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    store.setForwardReplies(granted)
    on = granted
  }
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Reencaminhar respostas dos clientes", color = TextPrimary, fontWeight = FontWeight.SemiBold)
        Text(
          "Quando um cliente responde a um SMS, a resposta aparece no PC, na ficha dele. Mensagens de quem não é cliente nunca saem do telemóvel.",
          color = TextSecondary, style = MaterialTheme.typography.bodySmall
        )
      }
      Spacer(Modifier.width(12.dp))
      Switch(checked = on, onCheckedChange = { want ->
        if (want && !allowed()) permission.launch(Manifest.permission.RECEIVE_SMS)
        else { store.setForwardReplies(want); on = want }
      })
    }
  }
}
