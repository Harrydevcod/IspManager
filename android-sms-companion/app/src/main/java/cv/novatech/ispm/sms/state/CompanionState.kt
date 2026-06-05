package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest

const val HISTORY_LIMIT = 20
private val TERMINAL = setOf("sent", "rejected", "failed")

data class RequestUi(
  val id: String,
  val clientName: String?,
  val toPhone: String,
  val eventType: String,
  val body: String,
  val status: String,
  val error: String?,
  val sending: Boolean = false
)

data class PairingSnapshot(val paired: Boolean, val deviceName: String, val listenAddress: String)

data class CompanionUiState(
  val paired: Boolean = false,
  val deviceName: String = "",
  val listenAddress: String = "",
  val serverRunning: Boolean = false,
  val smsPermissionGranted: Boolean = false,
  val pending: List<RequestUi> = emptyList(),
  val history: List<RequestUi> = emptyList()
)

private fun SmsRequest.toUi(sending: Boolean) = RequestUi(
  id = id, clientName = clientName, toPhone = toPhone, eventType = eventType,
  body = body, status = status, error = error, sending = sending
)

fun buildUiState(
  pairing: PairingSnapshot,
  serverRunning: Boolean,
  smsPermissionGranted: Boolean,
  requests: List<SmsRequest>,
  sendingIds: Set<String>
): CompanionUiState {
  val ui = requests.map { it.toUi(sendingIds.contains(it.id)) }
  val pending = ui.filter { it.status == "pending_approval" }
  val history = ui.filter { it.status in TERMINAL }.asReversed().take(HISTORY_LIMIT)
  return CompanionUiState(
    paired = pairing.paired,
    deviceName = pairing.deviceName,
    listenAddress = pairing.listenAddress,
    serverRunning = serverRunning,
    smsPermissionGranted = smsPermissionGranted,
    pending = pending,
    history = history
  )
}
