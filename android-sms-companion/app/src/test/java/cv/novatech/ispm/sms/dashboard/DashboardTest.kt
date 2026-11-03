package cv.novatech.ispm.sms.dashboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardTest {
  // Shape produced by src/backend/lib/companion-snapshot.ts (schemaVersion 1).
  private val sample = """
    {"schemaVersion":1,"generatedAt":"2026-11-03T12:00:00.000Z","companyName":"Skynet",
     "operation":{"severity":"amber","headline":"2 antenas em baixo",
       "risks":[{"title":"Antena X","detail":"caiu 4 vezes","severity":"red","exposureCve":null}],
       "actions":[{"title":"Visitar","detail":"","severity":"amber","horizon":"now"}]},
     "money":{"paidMonthCve":150000,"paidPrevMonthCve":120000,"pendingMonthCve":45000,"pendingMonthCount":18,
       "pendingPreviousCve":30000,"overduePayments":9,
       "criticalOverdue":[{"clientName":"Ana Lopes","amountCve":2750,"daysOverdue":41}]},
     "network":{"tone":"warn","probeEnabled":true,"lastProbeAt":null,"downCount":2,
       "downNow":[{"name":"Antena X","since":"2026-11-03T11:00:00Z"}],"findingsCount":3,
       "wans":[{"name":"starlink1","running":true,"downBps":25000000,"upBps":null}],"wanReason":null},
     "customers":{"total":60,"active":52,"suspended":5,"openWorkOrders":2,"openTickets":1},
     "sms":{"today":{"sent":4,"delivered":3,"failed":1,"pending":2},"month":{"sent":80,"delivered":70,"failed":5,"pending":2}}}
  """.trimIndent()

  @Test fun parsesTheDesktopSnapshot() {
    val d = Dashboard.parse(sample)!!
    assertEquals("Skynet", d.companyName)
    assertEquals("amber", d.operation.severity)
    assertEquals("Antena X", d.operation.risks.single().title)
    assertEquals(150000L, d.money.paidMonthCve)
    assertEquals(Dashboard.Debtor("Ana Lopes", 2750, 41), d.money.criticalOverdue.single())
    assertEquals(Dashboard.Wan("starlink1", true, 25_000_000, null), d.network.wans!!.single())
    assertEquals(52, d.customers.active)
    assertEquals(Dashboard.SmsCounts(4, 3, 1, 2), d.sms.today)
  }

  @Test fun routerNotReadKeepsTheReason() {
    val d = Dashboard.parse(sample.replace("\"wans\":[{\"name\":\"starlink1\",\"running\":true,\"downBps\":25000000,\"upBps\":null}],\"wanReason\":null", "\"wans\":null,\"wanReason\":\"Fora da rede\""))!!
    assertNull(d.network.wans)
    assertEquals("Fora da rede", d.network.wanReason)
  }

  @Test fun rejectsOtherSchemasAndGarbage() {
    assertNull(Dashboard.parse(sample.replace("\"schemaVersion\":1", "\"schemaVersion\":2")))
    assertNull(Dashboard.parse("not json"))
    assertNull(Dashboard.parse("{}"))
  }

  @Test fun missingSectionsDegradeToNeutral() {
    val d = Dashboard.parse("""{"schemaVersion":1}""")!!
    assertEquals("green", d.operation.severity)
    assertEquals(0L, d.money.paidMonthCve)
    assertTrue(d.network.downNow.isEmpty())
  }

  @Test fun freshness() {
    val t = 1_000_000_000L
    assertEquals(Freshness.NONE, DashboardRules.freshness(null, t))
    assertEquals(Freshness.FRESH, DashboardRules.freshness(t - 5 * 60_000, t))
    assertEquals(Freshness.STALE, DashboardRules.freshness(t - 16 * 60_000, t))
  }

  @Test fun alertsOnlyOnTheChangeIntoRed() {
    assertTrue(DashboardRules.shouldAlert(null, "red"))
    assertTrue(DashboardRules.shouldAlert("amber", "red"))
    assertFalse(DashboardRules.shouldAlert("red", "red"))
    assertFalse(DashboardRules.shouldAlert("red", "amber"))
  }

  @Test fun cveIsWrittenTheProjectWay() {
    assertEquals("1.500\$00", DashboardRules.formatCve(1500))
    assertEquals("150.000\$00", DashboardRules.formatCve(150000))
    assertEquals("0\$00", DashboardRules.formatCve(0))
    assertEquals("-2.750\$00", DashboardRules.formatCve(-2750))
  }

  @Test fun bandwidth() {
    assertEquals("25.0 Mb/s", DashboardRules.formatBps(25_000_000))
    assertEquals("800 kb/s", DashboardRules.formatBps(800_000))
    assertEquals("—", DashboardRules.formatBps(null))
  }
}
