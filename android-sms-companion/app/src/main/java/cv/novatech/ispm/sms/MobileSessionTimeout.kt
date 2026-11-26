package cv.novatech.ispm.sms

internal object MobileSessionTimeout {
  private const val LIMIT_MS = 15 * 60 * 1000L
  fun expired(stoppedAt: Long, now: Long): Boolean = now < stoppedAt || now - stoppedAt >= LIMIT_MS
}
