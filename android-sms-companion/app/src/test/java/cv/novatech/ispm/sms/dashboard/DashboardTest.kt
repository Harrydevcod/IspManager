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

  // ISPM 2.53+: the same schema 1 with the Terreno fields added.
  private val withField = sample
    .replace(
      "\"criticalOverdue\":[{\"clientName\":\"Ana Lopes\",\"amountCve\":2750,\"daysOverdue\":41}]}",
      "\"criticalOverdue\":[{\"clientName\":\"Ana Lopes\",\"amountCve\":2750,\"daysOverdue\":41}]," +
        "\"debtors\":[{\"clientName\":\"Ana Lopes\",\"clientCode\":\"C1\",\"phone\":\"+2389912233\",\"amountCve\":5000,\"daysOverdue\":41}," +
        "{\"clientName\":\"Rui\",\"clientCode\":\"C2\",\"phone\":null,\"amountCve\":2500,\"daysOverdue\":3}]," +
        "\"cashToday\":{\"totalCve\":3500,\"byAccount\":[{\"name\":\"Caixa loja\",\"amountCve\":3500}]}," +
        "\"monthlyReceipts\":[{\"month\":\"2026-10\",\"amountCve\":63000},{\"month\":\"2026-11\",\"amountCve\":9500}]}"
    )
    .replace(
      "\"downNow\":[{\"name\":\"Antena X\",\"since\":\"2026-11-03T11:00:00Z\"}]",
      "\"downNow\":[{\"kind\":\"assignment\",\"id\":7,\"name\":\"Antena X\",\"since\":\"2026-11-03T11:00:00Z\"}]"
    )
    .replace(
      "\"customers\":",
      "\"work\":{\"orders\":[{\"id\":4,\"title\":\"Trocar antena\",\"priority\":\"alta\",\"scheduledAt\":null,\"assignedTo\":\"Zé\"," +
        "\"clientName\":\"Ana Lopes\",\"phone\":\"+2389912233\",\"address\":\"Rua 1\",\"zone\":\"Monte Sossego\",\"island\":\"São Vicente\"}]," +
        "\"tickets\":[{\"id\":9,\"subject\":\"Sem net\",\"priority\":\"media\",\"openedAt\":\"2026-11-03 10:00:00\",\"clientName\":\"Rui\",\"phone\":null}]},\"customers\":"
    )

  @Test fun parsesTheTerrenoFields() {
    val d = Dashboard.parse(withField)!!
    assertTrue(d.hasFieldData)
    assertEquals(Dashboard.Debtor("Ana Lopes", 5000, 41, "C1", "+2389912233"), d.money.debtors.first())
    assertNull(d.money.debtors[1].phone)
    assertEquals(3500L, d.money.cashToday.totalCve)
    assertEquals("Caixa loja", d.money.cashToday.byAccount.single().name)
    assertEquals(listOf("2026-10", "2026-11"), d.money.monthlyReceipts.map { it.month })
    assertEquals("assignment:7", d.network.downNow.single().key)
    assertEquals("Monte Sossego", d.work.orders.single().zone)
    assertNull(d.work.tickets.single().phone)
  }

  @Test fun anOlderDesktopHasNoTerrenoData() {
    val d = Dashboard.parse(sample)!!
    assertFalse(d.hasFieldData)
    assertTrue(d.money.debtors.isEmpty() && d.work.orders.isEmpty())
    assertEquals("name:Antena X", d.network.downNow.single().key) // no id: the name stands in
  }

  private fun down(id: Long, since: String = "2026-11-03T11:00:00Z") = Dashboard.Down("Antena $id", since, "assignment", id)

  @Test fun networkChangesBetweenSnapshots() {
    val now = FieldRules.parseInstant("2026-11-03T11:30:00Z")!!
    val c = FieldRules.networkChanges(listOf(down(1), down(2)), listOf(down(2), down(3)), now)
    assertEquals(listOf(3L), c.wentDown.map { it.id })
    assertEquals(1L, c.restored.single().down.id)
    assertEquals(30L, c.restored.single().minutesDown)
    assertEquals(2, c.count)
  }

  @Test fun aDesktopUpgradeDoesNotReannounceOutages() {
    val old = listOf(Dashboard.Down("Antena 1", "2026-11-03T11:00:00Z")) // 2.52: no id
    assertEquals(0, FieldRules.networkChanges(old, listOf(down(1)), 0).count)
  }

  @Test fun theFirstSnapshotNeverAlerts() {
    assertEquals(0, FieldRules.networkChanges(null, listOf(down(1), down(2)), 0).count)
  }

  @Test fun sqliteTimestampsAreUnderstood() {
    assertEquals(FieldRules.parseInstant("2026-11-03T10:00:00Z"), FieldRules.parseInstant("2026-11-03 10:00:00"))
    assertNull(FieldRules.parseInstant("ontem"))
  }

  @Test fun intentsForTheField() {
    assertEquals("tel:+2389912233", FieldRules.dialUri("+2389912233"))
    assertEquals("smsto:+2389912233", FieldRules.smsUri("+2389912233"))
    assertEquals("https://wa.me/2389912233", FieldRules.whatsappUrl("+238 991 22 33"))
    assertEquals("geo:0,0?q=Rua%201%2C%20Monte%20Sossego%2C%20Cabo%20Verde", FieldRules.mapsUri("Rua 1", "Monte Sossego", " "))
    assertNull(FieldRules.mapsUri(null, "", null))
  }
}
