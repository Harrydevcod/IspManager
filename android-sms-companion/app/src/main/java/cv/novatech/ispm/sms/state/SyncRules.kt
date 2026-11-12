package cv.novatech.ispm.sms.state

enum class SyncPhase { IDLE, WAITING, NO_ANSWER }

/**
 * "Sincronizar" on the phone. The phone can't call the desktop (its API stays on
 * 127.0.0.1), so the request rides on the next signed `GET /status`, which the
 * desktop makes every minute; the desktop then pushes the summary at once.
 */
object SyncRules {
  /** Three missed polls: the PC is off or on another network. */
  const val WAIT_MS = 3 * 60_000L

  fun phase(requestedAt: Long?, dashboardReceivedAt: Long?, now: Long): SyncPhase {
    if (requestedAt == null) return SyncPhase.IDLE
    if (dashboardReceivedAt != null && dashboardReceivedAt >= requestedAt) return SyncPhase.IDLE
    return if (now - requestedAt < WAIT_MS) SyncPhase.WAITING else SyncPhase.NO_ANSWER
  }
}
