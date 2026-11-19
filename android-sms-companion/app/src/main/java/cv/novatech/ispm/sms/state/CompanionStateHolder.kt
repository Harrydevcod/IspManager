package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.NotificationLog
import cv.novatech.ispm.sms.PairingStore
import cv.novatech.ispm.sms.RequestRules
import cv.novatech.ispm.sms.SmsRequest
import cv.novatech.ispm.sms.SmsRequestStore
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.events.FieldEvent
import cv.novatech.ispm.sms.net.localIpv4
import cv.novatech.ispm.sms.pairing.PendingPairing
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-wide state. Lives in [cv.novatech.ispm.sms.IspmSmsApp], not in the
 * Activity, so approvals keep running while the UI is gone. Approval is written
 * to disk before the undo window starts; a process death inside the window is
 * recovered on the next start (see RequestRules.recover).
 */
class CompanionStateHolder(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  private val scope: CoroutineScope,
  private val send: (SmsRequest, Int?) -> Unit,
  /** Waits for a SIM with room (SendScheduler), then calls back with it. Default: send now on the chosen SIM. */
  private val dispatch: suspend (SmsRequest, (Int?) -> Boolean) -> Unit = { _, go -> go(null) },
  private val now: () -> Long = System::currentTimeMillis,
  /** Onde fica o histórico do sino. Nulo nos testes que só olham para as regras. */
  private val notificationLog: NotificationLog? = null,
  /** O que o telemóvel manda ao PC quando o sino muda deste lado. */
  private val onNotificationEvent: (String, JSONObject) -> Unit = { _, _ -> }
) {
  private val _state = MutableStateFlow(CompanionUiState())
  val state: StateFlow<CompanionUiState> = _state

  @Volatile private var serverRunning = false
  @Volatile private var permissionGranted = false
  @Volatile private var device = DeviceSnapshot()
  @Volatile private var dashboard: Dashboard? = null
  @Volatile private var dashboardReceivedAt: Long? = null
  @Volatile private var lastDesktopAt: Long? = null
  @Volatile private var lastRejectedAt: Long? = null
  @Volatile private var syncRequestedAt: Long? = null
  @Volatile private var relay = RelayHealth()
  @Volatile var pendingPairing: PendingPairing? = null
    private set
  /** Requests waiting for their SIM: 0 = queued behind another, else when it can go. */
  private val waiting = java.util.concurrent.ConcurrentHashMap<String, Long>()
  private val undo = UndoController(scope, onSend = ::performSend)

  fun refresh() {
    val snap = PairingSnapshot(pairingStore.isPaired(), pairingStore.deviceName(), "${localIpv4()}:8765")
    val code = pendingPairing?.let { PairingCode(it.sas, it.desktopName, it.phoneConfirmed) }
    _state.value = buildUiState(
      snap, serverRunning, permissionGranted, requestStore.list(), undo.sendingIds, device, dashboard,
      dashboardReceivedAt, lastDesktopAt, lastRejectedAt, waiting.toMap(), syncRequestedAt, code,
      relay.failingSince, relay.lastError,
      notificationLog?.list().orEmpty(), notificationLog?.seenAt()
    )
  }

  fun setRelayHealth(value: RelayHealth) { relay = value; refresh() }

  /** Uma entrada que nasce aqui; segue para o PC pelo canal do pareamento. */
  fun appendNotification(entry: NotificationEntry) {
    notificationLog?.append(entry)
    onNotificationEvent(
      FieldEvent.NOTIFICATION_NEW,
      JSONObject()
        .put("uid", entry.uid).put("kind", entry.kind).put("severity", entry.severity)
        .put("title", entry.title).put("detail", entry.text ?: "").put("tab", entry.tab ?: "painel")
    )
    refresh()
  }

  /** Tocar numa entrada: lida já aqui, e o PC sabe no próximo tick. */
  fun markNotificationRead(uid: String) {
    notificationLog?.markRead(uid)
    onNotificationEvent(FieldEvent.NOTIFICATION_READ, JSONObject().put("uids", JSONArray(listOf(uid))))
    refresh()
  }

  fun markAllNotificationsRead() {
    val uids = notificationLog?.markAllRead().orEmpty()
    if (uids.isNotEmpty()) onNotificationEvent(FieldEvent.NOTIFICATION_READ, JSONObject().put("uids", JSONArray(uids)))
    refresh()
  }

  /** Abrir o painel apaga o número; cada entrada continua por ler até ser tocada. */
  fun markNotificationsSeen() {
    notificationLog?.markSeen(now())
    onNotificationEvent(FieldEvent.NOTIFICATION_SEEN, JSONObject())
    refresh()
  }

  /** Chegou um resumo com o histórico do PC. */
  fun acceptNotificationFeed(items: List<NotificationEntry>, feedSeenAt: Long?) {
    notificationLog?.acceptFeed(items, feedSeenAt)
    refresh()
  }

  fun setServerRunning(value: Boolean) { serverRunning = value; refresh() }
  fun setPermissionGranted(value: Boolean) { permissionGranted = value; refresh() }
  fun setDevice(value: DeviceSnapshot) { device = value; refresh() }
  fun setDashboard(value: Dashboard?, receivedAt: Long?) { dashboard = value; dashboardReceivedAt = receivedAt; refresh() }
  /** v1 QR (ISPM até à 2.66): the secret came in the QR itself. */
  fun pair(info: PairingInfo.V1) = commit(info.secret, info.deviceName, 1)

  /** v2 QR: derive the secret, show the code, wait for the PC to prove it (2 min). */
  fun beginPairing(info: PairingInfo.V2) {
    val pending = PendingPairing.start(info, now())
    pendingPairing = pending
    refresh()
    scope.launch {
      delay(PendingPairing.TTL_MS)
      if (pendingPairing === pending) cancelPairing()
    }
  }

  /** Called from the server thread once `POST /pair/confirm` checks out. */
  fun completePairing(pending: PendingPairing) {
    if (pendingPairing !== pending) return
    pendingPairing = null
    commit(pending.secret, pending.desktopName, 2)
  }

  /** The operator saw the same code on both screens. */
  fun confirmPairingOnPhone() {
    pendingPairing?.phoneConfirmed = true
    refresh()
  }

  fun cancelPairing() { pendingPairing = null; refresh() }

  private fun commit(secret: String, deviceName: String, version: Int) {
    pairingStore.save(secret, deviceName, version)
    lastDesktopAt = null; lastRejectedAt = null
    refresh()
  }

  fun unpair() {
    pendingPairing = null
    pairingStore.clear()
    lastDesktopAt = null; lastRejectedAt = null
    refresh()
  }
  fun requestSync() { syncRequestedAt = now(); refresh() }
  /** Goes in `GET /status` until the summary arrives or the wait runs out. */
  fun syncRequested(): Boolean = SyncRules.phase(syncRequestedAt, dashboardReceivedAt, now()) == SyncPhase.WAITING
  fun markDesktopSeen() { lastDesktopAt = now(); refresh() }
  fun markDesktopRejected() { lastRejectedAt = now(); refresh() }

  fun approve(id: String) {
    val row = requestStore.update(id) {
      if (it.status == "pending_approval") it.copy(status = "approved", approvedAt = now(), updatedAt = now()) else it
    }
    if (row?.status == "approved") undo.arm(id) { refresh() }
  }

  fun undoApprove(id: String) {
    undo.cancel(id) {}
    requestStore.update(id) {
      if (it.status == "approved") it.copy(status = "pending_approval", approvedAt = null, updatedAt = now()) else it
    }
    refresh()
  }

  /** Arms every pending request so the whole queue sends after the undo window. */
  fun approveAll() {
    _state.value.pending.filter { it.status == "pending_approval" }.forEach { approve(it.id) }
  }

  /** Rejects every request still waiting for a decision, in one go. */
  fun rejectAll() {
    RequestRules.rejectableIds(requestStore.list(), undo.sendingIds).forEach { requestStore.updateStatus(it, "rejected", "Rejeitado no Android") }
    refresh()
  }

  /** Re-arms requests that were approved when the process died. */
  fun rearm(ids: List<String>) = ids.forEach { undo.arm(it) { refresh() } }

  fun reject(id: String) { requestStore.updateStatus(id, "rejected", "Rejeitado no Android"); refresh() }

  /**
   * Reenviar um SMS falhado. Volta a "approved" e passa pela janela de "Anular",
   * pelo orçamento do SIM e pela pausa da operadora, como um envio normal.
   */
  fun resend(id: String) {
    val row = requestStore.update(id) { RequestRules.resend(it, now()) }
    if (row?.status == "approved") undo.arm(id) { refresh() }
    refresh()
  }

  /** Reenvia tudo o que falhou nas últimas 24 h. */
  fun resendFailed() {
    val day = 24L * 60 * 60 * 1000
    _state.value.history
      .filter { it.status == "failed" && now() - (it.updatedAt ?: 0L) < day }
      .forEach { resend(it.id) }
  }

  /** The scheduler calls back while waiting, so the queue shows "aguarda janela do SIM". */
  fun setWaiting(id: String, until: Long?) {
    if (until == null) waiting.remove(id) else waiting[id] = until
    refresh()
  }

  private suspend fun performSend(id: String) {
    // Still "approved" while it waits for a SIM: a process death re-queues it.
    val queued = requestStore.find(id)?.takeIf { it.status == "approved" } ?: return
    dispatch(queued) go@{ sim ->
      val req = requestStore.update(id) {
        if (it.status == "approved") it.copy(status = "sending", updatedAt = now()) else it
      }
      if (req?.status != "sending") return@go false
      try {
        send(req, sim)
        true
      } catch (e: Exception) {
        requestStore.updateStatus(id, "failed", e.message ?: "Falha no envio SMS")
        false
      }
    }
  }
}
