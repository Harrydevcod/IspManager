package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.PairingStore
import cv.novatech.ispm.sms.SmsRequest
import cv.novatech.ispm.sms.SmsRequestStore
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.net.localIpv4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * App-wide state. Lives in [cv.novatech.ispm.sms.IspmSmsApp], not in the
 * Activity, so approvals keep running while the UI is gone. Approval is written
 * to disk before the undo window starts; a process death inside the window is
 * recovered on the next start (see RequestRules.recover).
 */
class CompanionStateHolder(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  scope: CoroutineScope,
  private val send: (SmsRequest, Int?) -> Unit,
  /** Waits for a SIM with room (SendScheduler), then calls back with it. Default: send now on the chosen SIM. */
  private val dispatch: suspend (SmsRequest, (Int?) -> Boolean) -> Unit = { _, go -> go(null) },
  private val now: () -> Long = System::currentTimeMillis
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
  /** Requests waiting for their SIM: 0 = queued behind another, else when it can go. */
  private val waiting = java.util.concurrent.ConcurrentHashMap<String, Long>()
  private val undo = UndoController(scope, onSend = ::performSend)

  fun refresh() {
    val snap = PairingSnapshot(pairingStore.isPaired(), pairingStore.deviceName(), "${localIpv4()}:8765")
    _state.value = buildUiState(snap, serverRunning, permissionGranted, requestStore.list(), undo.sendingIds, device, dashboard, dashboardReceivedAt, lastDesktopAt, lastRejectedAt, waiting.toMap())
  }

  fun setServerRunning(value: Boolean) { serverRunning = value; refresh() }
  fun setPermissionGranted(value: Boolean) { permissionGranted = value; refresh() }
  fun setDevice(value: DeviceSnapshot) { device = value; refresh() }
  fun setDashboard(value: Dashboard?, receivedAt: Long?) { dashboard = value; dashboardReceivedAt = receivedAt; refresh() }
  fun pair(info: PairingInfo) {
    pairingStore.save(info.secret, info.deviceName)
    lastDesktopAt = null; lastRejectedAt = null
    refresh()
  }
  fun unpair() {
    pairingStore.clear()
    lastDesktopAt = null; lastRejectedAt = null
    refresh()
  }
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

  /** Re-arms requests that were approved when the process died. */
  fun rearm(ids: List<String>) = ids.forEach { undo.arm(it) { refresh() } }

  fun reject(id: String) { requestStore.updateStatus(id, "rejected", "Rejeitado no Android"); refresh() }

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
