package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest

const val HISTORY_LIMIT = 50
private val TERMINAL = setOf("sent", "rejected", "failed")
private val OPEN = setOf("pending_approval", "approved", "sending")

data class RequestUi(
  val id: String,
  val clientName: String?,
  val toPhone: String,
  val eventType: String,
  val body: String,
  val status: String,
  val error: String?,
  /** Inside the undo window: the operator can still cancel. */
  val sending: Boolean = false,
  /** Handed to the radio, waiting for the network's SENT report. */
  val inFlight: Boolean = false,
  val updatedAt: Long? = null,
  val deliveredAt: Long? = null
)

data class SimOption(val subscriptionId: Int, val label: String)

data class PairingSnapshot(val paired: Boolean, val deviceName: String, val listenAddress: String)

data class CompanionUiState(
  val paired: Boolean = false,
  val deviceName: String = "",
  val listenAddress: String = "",
  val serverRunning: Boolean = false,
  val smsPermissionGranted: Boolean = false,
  val batteryExempt: Boolean = true,
  val dualSimCapable: Boolean = false,
  val sims: List<SimOption> = emptyList(),
  val selectedSim: Int? = null,
  val pending: List<RequestUi> = emptyList(),
  val history: List<RequestUi> = emptyList()
)

/** Platform facts the holder doesn't own; refreshed by the Activity on resume. */
data class DeviceSnapshot(
  val batteryExempt: Boolean = true,
  val dualSimCapable: Boolean = false,
  val sims: List<SimOption> = emptyList(),
  val selectedSim: Int? = null
)

private fun SmsRequest.toUi(sending: Boolean) = RequestUi(
  id = id, clientName = clientName, toPhone = toPhone, eventType = eventType,
  body = body, status = status, error = error, sending = sending,
  inFlight = status == "sending", updatedAt = updatedAt, deliveredAt = deliveredAt
)

fun buildUiState(
  pairing: PairingSnapshot,
  serverRunning: Boolean,
  smsPermissionGranted: Boolean,
  requests: List<SmsRequest>,
  sendingIds: Set<String>,
  device: DeviceSnapshot = DeviceSnapshot()
): CompanionUiState {
  val ui = requests.map { it.toUi(sendingIds.contains(it.id)) }
  val pending = ui.filter { it.status in OPEN }
  // Stable sort: rows without timestamps (written by 0.1.0) keep newest-first insertion order.
  val history = ui.filter { it.status in TERMINAL }.asReversed()
    .sortedByDescending { it.updatedAt ?: 0L }
    .take(HISTORY_LIMIT)
  return CompanionUiState(
    paired = pairing.paired,
    deviceName = pairing.deviceName,
    listenAddress = pairing.listenAddress,
    serverRunning = serverRunning,
    smsPermissionGranted = smsPermissionGranted,
    batteryExempt = device.batteryExempt,
    dualSimCapable = device.dualSimCapable,
    sims = device.sims,
    selectedSim = device.selectedSim,
    pending = pending,
    history = history
  )
}
