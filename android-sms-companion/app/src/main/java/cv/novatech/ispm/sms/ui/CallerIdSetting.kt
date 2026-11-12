package cv.novatech.ispm.sms.ui

import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

/**
 * "Identificar quem liga": the call-screening role is the system's to grant and
 * revoke, so the setting reads it every time instead of keeping its own copy.
 * Android 10+ only; older phones don't see the setting.
 */
@Composable
fun CallerIdSetting() {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
  val context = LocalContext.current
  var held by remember { mutableStateOf(holdsRole(context)) }
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { held = holdsRole(context) }
  Column(
    Modifier.fillMaxWidth()
      .clip(RoundedCornerShape(14.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(14.dp))
      .padding(14.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text("Identificar clientes que ligam", color = TextPrimary, fontWeight = FontWeight.SemiBold)
      }
      Spacer(Modifier.width(12.dp))
      if (held) {
        Text("Ativo", color = Success, style = MaterialTheme.typography.labelMedium)
      } else {
        TextButton(onClick = {
          val roles = context.getSystemService(RoleManager::class.java)
          launcher.launch(roles.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING))
        }) { Text("Ativar", color = AccentBlue, fontWeight = FontWeight.SemiBold) }
      }
    }
  }
}

private fun holdsRole(context: Context): Boolean =
  Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
    context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
