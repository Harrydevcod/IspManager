package cv.novatech.ispm.sms.ui.theme

import androidx.compose.ui.graphics.Color

data class BadgeStyle(val label: String, val fg: Color, val bg: Color)

fun badgeFor(eventType: String): BadgeStyle = when (eventType) {
  "receipt_confirmed" -> BadgeStyle("Recibo", AccentOrange, AccentOrange.copy(alpha = 0.14f))
  "payment_overdue" -> BadgeStyle("Atraso", Danger, Danger.copy(alpha = 0.14f))
  "invoice_issued" -> BadgeStyle("Fatura", AccentBlue, AccentBlue.copy(alpha = 0.16f))
  "suspension_notice" -> BadgeStyle("Suspensão", Warn, Warn.copy(alpha = 0.14f))
  else -> BadgeStyle("Teste", TextSecondary, BorderC)
}
