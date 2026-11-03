package cv.novatech.ispm.sms

/**
 * Nonces of requests whose signed timestamp is still acceptable. A replayed
 * request carries a valid signature and a fresh-enough timestamp, so only the
 * nonce gives it away. Each nonce is kept until its own timestamp leaves the
 * skew window (`expiresAt`), not for a fixed time after we saw it: a request
 * stamped up to 5 min in the future stays replayable for up to 10 min.
 */
class NonceCache {
  private val expiry = HashMap<String, Long>()

  /** True the first time [nonce] is seen before it expires; false on a replay. */
  @Synchronized fun firstUse(nonce: String, now: Long, expiresAt: Long): Boolean {
    expiry.entries.removeAll { now > it.value }
    if (expiry.containsKey(nonce)) return false
    expiry[nonce] = expiresAt
    return true
  }
}
