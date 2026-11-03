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
  private val send: (SmsRequest) -> Unit,
  private val now: () -> Long = System::currentTimeMillis
) {
  private val _state = MutableStateFlow(CompanionUiState())
  val state: StateFlow<CompanionUiState> = _state

  @Volatile private var serverRunning = false
  @Volatile private var permissionGranted = false
  @Volatile private var device = DeviceSnapshot()
  @Volatile private var dashboard: Dashboard? = null
  @Volatile private var dashboardReceivedAt: Long? = null
  private val undo = UndoController(scope, onSend = ::performSend)

  fun refresh() {
    val snap = PairingSnapshot(pairingStore.isPaired(), pairingStore.deviceName(), "${localIpv4()}:8765")
    _state.value = buildUiState(snap, serverRunning, permissionGranted, requestStore.list(), undo.sendingIds, device, dashboard, dashboardReceivedAt)
  }

  fun setServerRunning(value: Boolean) { serverRunning = value; refresh() }
  fun setPermissionGranted(value: Boolean) { permissionGranted = value; refresh() }
  fun setDevice(value: DeviceSnapshot) { device = value; refresh() }
  fun setDashboard(value: Dashboard?, receivedAt: Long?) { dashboard = value; dashboardReceivedAt = receivedAt; refresh() }
  fun pair(info: PairingInfo) { pairingStore.save(info.secret, info.deviceName); refresh() }
  fun unpair() { pairingStore.clear(); refresh() }

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

  private suspend fun performSend(id: String) {
    val req = requestStore.update(id) {
      if (it.status == "approved") it.copy(status = "sending", updatedAt = now()) else it
    } ?: return
    if (req.status != "sending") return
    try {
      send(req)
    } catch (e: Exception) {
      requestStore.updateStatus(id, "failed", e.message ?: "Falha no envio SMS")
    }
  }
}
