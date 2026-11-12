package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest
import cv.novatech.ispm.sms.dashboard.Dashboard

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
  val deliveredAt: Long? = null,
  /** Approved but waiting for a SIM with room: 0 = behind another request, else when it can go. */
  val waitUntil: Long? = null
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
  val lockEnabled: Boolean = true,
  /** The phone has a screen lock (fingerprint/PIN); without it the app lock can't work. */
  val deviceSecure: Boolean = true,
  val pending: List<RequestUi> = emptyList(),
  val history: List<RequestUi> = emptyList(),
  val dashboard: Dashboard? = null,
  val dashboardReceivedAt: Long? = null,
  /** Last request signed with our secret (in memory: resets with the process). */
  val lastDesktopAt: Long? = null,
  /** Last signed request that failed verification: the desktop has another secret. */
  val lastRejectedAt: Long? = null,
  /** "Sincronizar" pressed; see [SyncRules]. In memory: resets with the process. */
  val syncRequestedAt: Long? = null
)

enum class DesktopLink { LINKED, WAITING, MISMATCH }

/** The desktop asks every minute; 3 min of silence is no longer "linked" (same window as the desktop). */
const val LINK_WINDOW_MS = 3 * 60_000L

fun desktopLink(state: CompanionUiState, now: Long): DesktopLink {
  val seen = state.lastDesktopAt
  val rejected = state.lastRejectedAt
  if (rejected != null && now - rejected <= LINK_WINDOW_MS && (seen == null || rejected > seen)) return DesktopLink.MISMATCH
  if (seen != null && now - seen <= LINK_WINDOW_MS) return DesktopLink.LINKED
  return DesktopLink.WAITING
}

/** Platform facts the holder doesn't own; refreshed by the Activity on resume. */
data class DeviceSnapshot(
  val batteryExempt: Boolean = true,
  val dualSimCapable: Boolean = false,
  val sims: List<SimOption> = emptyList(),
  val selectedSim: Int? = null,
  val lockEnabled: Boolean = true,
  val deviceSecure: Boolean = true
)

private fun SmsRequest.toUi(sending: Boolean, waitUntil: Long?) = RequestUi(
  id = id, clientName = clientName, toPhone = toPhone, eventType = eventType,
  body = body, status = status, error = error, sending = sending,
  inFlight = status == "sending", updatedAt = updatedAt, deliveredAt = deliveredAt,
  waitUntil = waitUntil.takeIf { status == "approved" }
)

fun buildUiState(
  pairing: PairingSnapshot,
  serverRunning: Boolean,
  smsPermissionGranted: Boolean,
  requests: List<SmsRequest>,
  sendingIds: Set<String>,
  device: DeviceSnapshot = DeviceSnapshot(),
  dashboard: Dashboard? = null,
  dashboardReceivedAt: Long? = null,
  lastDesktopAt: Long? = null,
  lastRejectedAt: Long? = null,
  waiting: Map<String, Long> = emptyMap(),
  syncRequestedAt: Long? = null
): CompanionUiState {
  val ui = requests.map { it.toUi(sendingIds.contains(it.id), waiting[it.id]) }
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
    lockEnabled = device.lockEnabled,
    deviceSecure = device.deviceSecure,
    pending = pending,
    history = history,
    dashboard = dashboard,
    dashboardReceivedAt = dashboardReceivedAt,
    lastDesktopAt = lastDesktopAt,
    lastRejectedAt = lastRejectedAt,
    syncRequestedAt = syncRequestedAt
  )
}
