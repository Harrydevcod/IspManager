package cv.novatech.ispm.sms.state

/**
 * O que precisa de atenção agora, derivado do estado — nada se guarda.
 *
 * Os avisos da app estavam espalhados (banners nos Pedidos e nos Ajustes, o
 * cartão de estado, o selo do separador), e cada um só se via no ecrã onde
 * vivia. Aqui ficam todos, numa lista ordenada pela gravidade, para o sino os
 * mostrar no topo de qualquer ecrã.
 *
 * Função pura: sem Android, sem relógio interno. O `now` entra por parâmetro.
 */

enum class AlertSeverity { Danger, Warn, Info }

enum class AlertAction {
  ApproveAll, ResendAllFailed, OpenPedidos, OpenHistorico, OpenPainel, OpenAjustes,
  RequestSmsPermission, RequestBatteryExemption, Sync, Unpair, None
}

data class Alert(
  val key: String,
  val severity: AlertSeverity,
  val title: String,
  val line: String? = null,
  val action: AlertAction = AlertAction.None,
  val actionLabel: String? = null,
  val secondary: AlertAction? = null,
  val secondaryLabel: String? = null
)

/** Uma falha de envio deixa de contar passadas 24 h: já não é o problema de agora. */
private const val FAILED_WINDOW_MS = 24 * 60 * 60 * 1000L

/** O relé tem de estar em baixo cinco minutos antes de valer um aviso. */
const val RELAY_DOWN_AFTER_MS = 5 * 60_000L

fun alertsFor(state: CompanionUiState, now: Long): List<Alert> {
  val alerts = mutableListOf<Alert>()

  if (desktopLink(state, now) == DesktopLink.MISMATCH) {
    alerts += Alert(
      key = "mismatch", severity = AlertSeverity.Danger,
      title = "PC ligado a outro pareamento",
      action = AlertAction.Unpair, actionLabel = "Desemparelhar"
    )
  }

  if (!state.serverRunning) {
    alerts += Alert("server", AlertSeverity.Danger, "Servidor parado", "Reabra a app")
  }

  if (!state.smsPermissionGranted) {
    alerts += Alert(
      key = "sms-permission", severity = AlertSeverity.Danger,
      title = "Sem permissão para enviar SMS",
      action = AlertAction.RequestSmsPermission, actionLabel = "Permitir"
    )
  }

  val operation = state.dashboard?.operation
  if (operation != null && operation.severity == "red") {
    alerts += Alert(
      key = "ops", severity = AlertSeverity.Danger, title = operation.headline,
      action = AlertAction.OpenPainel, actionLabel = "Ver"
    )
  }

  val down = state.dashboard?.network?.downNow?.size ?: 0
  if (down > 0) {
    alerts += Alert(
      key = "down", severity = AlertSeverity.Danger,
      title = if (down == 1) "1 equipamento em baixo" else "$down equipamentos em baixo",
      action = AlertAction.OpenPainel, actionLabel = "Ver"
    )
  }

  val failingSince = state.relayFailingSince
  if (failingSince != null && now - failingSince >= RELAY_DOWN_AFTER_MS) {
    alerts += Alert(
      key = "relay", severity = AlertSeverity.Danger, title = "Relé sem ligação",
      line = state.relayLastError,
      action = AlertAction.OpenAjustes, actionLabel = "Ver"
    )
  }

  val waiting = state.pending.count { it.status == "pending_approval" }
  if (waiting > 0) {
    alerts += Alert(
      key = "pending", severity = AlertSeverity.Warn,
      title = if (waiting == 1) "1 SMS à espera de aprovação" else "$waiting SMS à espera de aprovação",
      action = AlertAction.ApproveAll, actionLabel = "Aprovar todos",
      secondary = AlertAction.OpenPedidos, secondaryLabel = "Ver"
    )
  }

  val failed = state.history.filter { it.status == "failed" && now - (it.updatedAt ?: 0L) < FAILED_WINDOW_MS }
  if (failed.isNotEmpty()) {
    alerts += Alert(
      key = "failed", severity = AlertSeverity.Warn,
      title = if (failed.size == 1) "1 SMS falhou" else "${failed.size} SMS falharam",
      line = failed.first().error,
      action = AlertAction.ResendAllFailed, actionLabel = "Reenviar",
      secondary = AlertAction.OpenHistorico, secondaryLabel = "Ver"
    )
  }

  when (SyncRules.phase(state.syncRequestedAt, state.dashboardReceivedAt, now)) {
    SyncPhase.NO_ANSWER -> alerts += Alert(
      key = "sync", severity = AlertSeverity.Warn, title = "Painel sem resposta",
      action = AlertAction.Sync, actionLabel = "Sincronizar"
    )
    else -> Unit
  }

  if (!state.batteryExempt) {
    alerts += Alert(
      key = "battery", severity = AlertSeverity.Info, title = "Otimização de bateria ativa",
      action = AlertAction.RequestBatteryExemption, actionLabel = "Isentar"
    )
  }

  if (state.lockEnabled && !state.deviceSecure) {
    alerts += Alert(
      key = "lock-no-pin", severity = AlertSeverity.Info, title = "Bloqueio sem PIN no telemóvel",
      action = AlertAction.OpenAjustes, actionLabel = "Ver"
    )
  }

  // Estável: dentro da mesma gravidade fica a ordem em que foram acrescentados.
  return alerts.sortedBy { it.severity.ordinal }
}
