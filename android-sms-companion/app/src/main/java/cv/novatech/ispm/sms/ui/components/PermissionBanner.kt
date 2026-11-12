package cv.novatech.ispm.sms.ui.components

import androidx.compose.runtime.Composable

@Composable
fun PermissionBanner(
  onRequest: () -> Unit,
  title: String = "Sem permissão para enviar SMS",
  action: String = "Permitir"
) = Banner(title, action, onRequest)
