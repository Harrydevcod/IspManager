package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.dashboard.Dashboard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertsTest {
  private val now = 1_700_000_000_000L

  /** Estado são: emparelhado, servidor de pé, permissões dadas, nada por tratar. */
  private fun healthy() = CompanionUiState(
    paired = true,
    serverRunning = true,
    smsPermissionGranted = true,
    batteryExempt = true,
    lockEnabled = false,
    deviceSecure = true,
    lastDesktopAt = now - 10_000
  )

  private fun request(id: String, status: String, error: String? = null, updatedAt: Long = now) =
    RequestUi(id = id, clientName = null, toPhone = "+2389912233", eventType = "test", body = "x",
      status = status, error = error, updatedAt = updatedAt)

  private fun keys(state: CompanionUiState) = alertsFor(state, now).map { it.key }

  @Test fun `estado sao nao gera alertas`() {
    assertEquals(emptyList<String>(), keys(healthy()))
  }

  @Test fun `sem permissao de SMS avisa a vermelho`() {
    val alert = alertsFor(healthy().copy(smsPermissionGranted = false), now).single()
    assertEquals("sms-permission", alert.key)
    assertEquals(AlertSeverity.Danger, alert.severity)
    assertEquals(AlertAction.RequestSmsPermission, alert.action)
  }

  @Test fun `servidor parado avisa a vermelho`() {
    val alert = alertsFor(healthy().copy(serverRunning = false), now).single()
    assertEquals("server", alert.key)
    assertEquals(AlertSeverity.Danger, alert.severity)
  }

  @Test fun `PC noutro pareamento oferece desemparelhar`() {
    val state = healthy().copy(lastDesktopAt = null, lastRejectedAt = now - 10_000)
    val alert = alertsFor(state, now).single()
    assertEquals("mismatch", alert.key)
    assertEquals(AlertAction.Unpair, alert.action)
  }

  @Test fun `pedidos a espera oferecem aprovar todos`() {
    val state = healthy().copy(pending = listOf(request("a", "pending_approval"), request("b", "pending_approval")))
    val alert = alertsFor(state, now).single()
    assertEquals("pending", alert.key)
    assertEquals("2 SMS à espera de aprovação", alert.title)
    assertEquals(AlertAction.ApproveAll, alert.action)
    assertEquals(AlertAction.OpenPedidos, alert.secondary)
  }

  @Test fun `um pedido so fala no singular`() {
    val state = healthy().copy(pending = listOf(request("a", "pending_approval")))
    assertEquals("1 SMS à espera de aprovação", alertsFor(state, now).single().title)
  }

  @Test fun `um SMS falhado oferece reenviar, com a razao`() {
    val state = healthy().copy(history = listOf(request("a", "failed", error = "Sem serviço de rede")))
    val alert = alertsFor(state, now).single()
    assertEquals("failed", alert.key)
    assertEquals("1 SMS falhou", alert.title)
    assertEquals("Sem serviço de rede", alert.line)
    assertEquals(AlertAction.ResendAllFailed, alert.action)
  }

  @Test fun `falha com mais de 24 h ja nao conta`() {
    val old = request("a", "failed", updatedAt = now - 25 * 60 * 60 * 1000L)
    assertEquals(emptyList<String>(), keys(healthy().copy(history = listOf(old))))
  }

  @Test fun `equipamento em baixo vem do painel`() {
    val network = Dashboard.Network("danger", 2, listOf(
      Dashboard.Down("CIBEL_AP", "2026-11-19 09:00:00", "backbone", 7L),
      Dashboard.Down("DALILA_AP", "2026-11-19 09:00:00", "backbone", 8L)
    ), 0, null, null)
    val state = healthy().copy(dashboard = dashboard(network = network))
    val alert = alertsFor(state, now).single()
    assertEquals("down", alert.key)
    assertEquals("2 equipamentos em baixo", alert.title)
  }

  @Test fun `operacao a vermelho mostra a manchete`() {
    val operation = Dashboard.Operation("red", "Cobrança parada", emptyList(), emptyList())
    val alert = alertsFor(healthy().copy(dashboard = dashboard(operation = operation)), now).single()
    assertEquals("ops", alert.key)
    assertEquals("Cobrança parada", alert.title)
  }

  @Test fun `rele so avisa passados cinco minutos`() {
    val recente = healthy().copy(relayFailingSince = now - 4 * 60_000L)
    assertEquals(emptyList<String>(), keys(recente))

    val antigo = healthy().copy(relayFailingSince = now - RELAY_DOWN_AFTER_MS, relayLastError = "Sem resposta")
    val alert = alertsFor(antigo, now).single()
    assertEquals("relay", alert.key)
    assertEquals(AlertSeverity.Danger, alert.severity)
    assertEquals("Sem resposta", alert.line)
  }

  @Test fun `painel sem resposta oferece sincronizar`() {
    val state = healthy().copy(syncRequestedAt = now - SyncRules.WAIT_MS - 1)
    val alert = alertsFor(state, now).single()
    assertEquals("sync", alert.key)
    assertEquals(AlertAction.Sync, alert.action)
  }

  @Test fun `a espera da sincronizacao ainda nao avisa`() {
    assertEquals(emptyList<String>(), keys(healthy().copy(syncRequestedAt = now - 10_000)))
  }

  @Test fun `bateria e bloqueio sem PIN sao informativos`() {
    val state = healthy().copy(batteryExempt = false, lockEnabled = true, deviceSecure = false)
    assertEquals(listOf("battery", "lock-no-pin"), keys(state))
    assertTrue(alertsFor(state, now).all { it.severity == AlertSeverity.Info })
  }

  @Test fun `vermelho antes de amarelo, e amarelo antes de azul`() {
    val state = healthy().copy(
      smsPermissionGranted = false,
      batteryExempt = false,
      pending = listOf(request("a", "pending_approval"))
    )
    assertEquals(listOf("sms-permission", "pending", "battery"), keys(state))
  }

  private fun dashboard(
    operation: Dashboard.Operation = Dashboard.Operation("green", "Tudo em ordem", emptyList(), emptyList()),
    network: Dashboard.Network = Dashboard.Network("ok", 0, emptyList(), 0, null, null)
  ) = Dashboard(
    generatedAt = "2026-11-19T09:00:00Z",
    companyName = "ISPM",
    operation = operation,
    money = Dashboard.Money(0L, 0L, 0L, 0, 0L, 0, emptyList()),
    network = network,
    customers = Dashboard.Customers(0, 0, 0, 0, 0),
    sms = Dashboard.Sms(Dashboard.SmsCounts(0, 0, 0, 0), Dashboard.SmsCounts(0, 0, 0, 0))
  )
}
