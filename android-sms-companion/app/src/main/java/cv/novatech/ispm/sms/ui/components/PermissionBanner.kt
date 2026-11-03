package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

@Composable
fun PermissionBanner(
  onRequest: () -> Unit,
  title: String = "Permitir envio de SMS",
  action: String = "Permitir →"
) {
  Row(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(12.dp)).background(Warn.copy(alpha = 0.12f))
      .clickable { onRequest() }.padding(14.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween
  ) {
    Text(title, color = Warn, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
    Spacer(Modifier.width(8.dp))
    Text(action, color = Warn)
  }
}
