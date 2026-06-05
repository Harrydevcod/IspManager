package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.PairingStore
import cv.novatech.ispm.sms.SmsRequest
import cv.novatech.ispm.sms.SmsRequestStore
import cv.novatech.ispm.sms.net.localIpv4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class CompanionStateHolder(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  scope: CoroutineScope,
  private val send: (SmsRequest) -> Unit
) {
  private val _state = MutableStateFlow(CompanionUiState())
  val state: StateFlow<CompanionUiState> = _state

  private var serverRunning = false
  private var permissionGranted = false
  private val undo = UndoController(scope, onSend = ::performSend)

  fun refresh() {
    val snap = PairingSnapshot(pairingStore.isPaired(), pairingStore.deviceName(), "${localIpv4()}:8765")
    _state.value = buildUiState(snap, serverRunning, permissionGranted, requestStore.list(), undo.sendingIds)
  }

  fun setServerRunning(value: Boolean) { serverRunning = value; refresh() }
  fun setPermissionGranted(value: Boolean) { permissionGranted = value; refresh() }
  fun pair(info: PairingInfo) { pairingStore.save(info.secret, info.deviceName); refresh() }
  fun unpair() { pairingStore.clear(); refresh() }

  fun approve(id: String) = undo.arm(id) { refresh() }
  fun undoApprove(id: String) = undo.cancel(id) { refresh() }

  /** Arms every pending request so the whole queue sends after the undo window. */
  fun approveAll() {
    _state.value.pending.forEach { undo.arm(it.id) { refresh() } }
  }
  fun reject(id: String) { requestStore.updateStatus(id, "rejected", "Rejeitado no Android"); refresh() }

  private suspend fun performSend(id: String) {
    val req = requestStore.find(id) ?: return
    try {
      send(req)
      requestStore.updateStatus(id, "sent", null)
    } catch (e: Exception) {
      requestStore.updateStatus(id, "failed", e.message ?: "Falha no envio SMS")
    }
  }
}
