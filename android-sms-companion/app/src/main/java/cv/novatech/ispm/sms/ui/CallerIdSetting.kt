package cv.novatech.ispm.sms.ui

import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import cv.novatech.ispm.sms.ui.components.ButtonVariant
import cv.novatech.ispm.sms.ui.components.GroupDivider
import cv.novatech.ispm.sms.ui.components.GroupRow
import cv.novatech.ispm.sms.ui.components.IspmButton
import cv.novatech.ispm.sms.ui.theme.*

/**
 * "Identificar quem liga", as a row of the Segurança group: the call-screening
 * role is the system's to grant and revoke, so the row reads it every time
 * instead of keeping its own copy. Android 10+ only; older phones don't see it.
 */
@Composable
fun CallerIdRow() {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
  val context = LocalContext.current
  var held by remember { mutableStateOf(holdsRole(context)) }
  val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { held = holdsRole(context) }
  GroupDivider()
  GroupRow("Identificar clientes que ligam") {
    if (held) {
      Text("Ativo", color = Success, style = MaterialTheme.typography.labelMedium)
    } else {
      IspmButton("Ativar", {
        val roles = context.getSystemService(RoleManager::class.java)
        launcher.launch(roles.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING))
      }, variant = ButtonVariant.SECONDARY)
    }
  }
}

private fun holdsRole(context: Context): Boolean =
  Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
    context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_CALL_SCREENING) == true
