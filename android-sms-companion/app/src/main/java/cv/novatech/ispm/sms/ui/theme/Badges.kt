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
  "payment_reminder" -> BadgeStyle("Lembrete", Info, InfoBg)
  "payment_warning" -> BadgeStyle("Atraso", Danger, DangerBg)
  "fup_notice" -> BadgeStyle("Uso justo", Warn, WarnBg)
  "outage_notice" -> BadgeStyle("Avaria", Danger, DangerBg)
  "outage_restored" -> BadgeStyle("Reposto", Success, SuccessBg)
  "maintenance_notice" -> BadgeStyle("Manutenção", Warn, WarnBg)
  "general" -> BadgeStyle("Mensagem", TextSecondary, Surface3)
  else -> BadgeStyle("Teste", TextSecondary, Surface3)
}
