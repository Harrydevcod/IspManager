package cv.novatech.ispm.sms

/**
 * Nonces seen inside the signature's clock window. A replayed request carries a
 * valid signature and a fresh-enough timestamp, so only the nonce gives it away.
 * Entries older than the window are dropped on every check, which bounds memory
 * to the requests of the last [windowMs].
 */
class NonceCache(private val windowMs: Long = 5 * 60_000L) {
  private val seen = HashMap<String, Long>()

  /** True the first time [nonce] is seen within the window; false on a replay. */
  @Synchronized fun firstUse(nonce: String, now: Long): Boolean {
    seen.entries.removeAll { now - it.value > windowMs }
    if (seen.containsKey(nonce)) return false
    seen[nonce] = now
    return true
  }
}
