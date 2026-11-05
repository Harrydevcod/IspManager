package cv.novatech.ispm.sms.widget

import cv.novatech.ispm.sms.dashboard.Dashboard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class WidgetRulesTest {
  private val dashboard = Dashboard.parse(
    """{"schemaVersion":1,"money":{"cashToday":{"totalCve":12500,"byAccount":[]}},"network":{"downCount":2}}"""
  )!!

  @Test fun unlockedShowsTheCash() {
    assertEquals(
      WidgetContent("Caixa de hoje · 12.500\$00", "Rede · 2 equipamentos em baixo", "SMS · 1 por aprovar"),
      WidgetRules.content(dashboard, pending = 1, showAmounts = true)
    )
  }

  @Test fun lockedHidesMoneyButKeepsCounts() {
    val c = WidgetRules.content(dashboard, pending = 3, showAmounts = false)
    assertFalse(c.cash.contains("12.500"))
    assertEquals("Rede · 2 equipamentos em baixo", c.down)
    assertEquals("SMS · 3 por aprovar", c.pending)
  }

  @Test fun beforeTheFirstSummary() {
    assertEquals(
      WidgetContent("Sem resumo do PC", "Rede · sem dados", "SMS · nada por aprovar"),
      WidgetRules.content(null, pending = 0, showAmounts = true)
    )
  }
}
