package cv.novatech.ispm.sms

/**
 * When the UI must ask for the fingerprint or the phone's PIN. The lock guards
 * the screens only: the server and the approvals keep running underneath.
 */
object LockRules {
  /** Back from a call, the map or WhatsApp within this window: no new prompt. */
  const val GRACE_MS = 2 * 60_000L

  /**
   * @param enabled the operator's choice in Definições
   * @param deviceSecure the phone has a screen lock; without one there is nothing to
   *   ask for, and locking would only shut the operator out
   * @param unlocked unlocked since this process started (a new process starts locked)
   * @param backgroundAt when the UI last went to the background, null if it hasn't
   */
  fun mustLock(enabled: Boolean, deviceSecure: Boolean, unlocked: Boolean, backgroundAt: Long?, now: Long): Boolean {
    if (!enabled || !deviceSecure) return false
    if (!unlocked) return true
    return backgroundAt != null && now - backgroundAt >= GRACE_MS
  }
}
