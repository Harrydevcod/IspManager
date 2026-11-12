package cv.novatech.ispm.sms.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

data class BadgeStyle(val label: String, val fg: Color, val bg: Color)

// Same semantic vocabulary as the desktop: money owed = danger, receipts = success, invoices = info.
@Composable @ReadOnlyComposable
fun badgeFor(eventType: String): BadgeStyle = when (eventType) {
  "receipt_confirmed" -> BadgeStyle("Recibo", Success, SuccessBg)
  "payment_overdue" -> BadgeStyle("Atraso", Danger, DangerBg)
  "invoice_issued" -> BadgeStyle("Fatura", Info, InfoBg)
  "suspension_notice" -> BadgeStyle("Suspensão", Warn, WarnBg)
  else -> BadgeStyle("Teste", TextSecondary, Surface3)
}
