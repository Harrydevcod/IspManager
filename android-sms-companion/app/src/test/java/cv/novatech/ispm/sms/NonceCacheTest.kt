package cv.novatech.ispm.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NonceCacheTest {
  private val skew = 5 * 60_000L

  @Test fun replayInsideWindowIsRejected() {
    val cache = NonceCache()
    assertTrue(cache.firstUse("n1", now = 0, expiresAt = skew))
    assertFalse(cache.firstUse("n1", now = 500, expiresAt = skew))
    assertTrue(cache.firstUse("n2", now = 500, expiresAt = skew))
  }

  @Test fun futureStampedNonceIsKeptUntilItsTimestampExpires() {
    val cache = NonceCache()
    // Request stamped 5 min ahead: its timestamp stays acceptable until now + 10 min.
    val sentAt = skew
    assertTrue(cache.firstUse("n1", now = 0, expiresAt = sentAt + skew))
    assertFalse(cache.firstUse("n1", now = 9 * 60_000L, expiresAt = sentAt + skew))
  }

  @Test fun expiredNoncesArePurged() {
    val cache = NonceCache()
    assertTrue(cache.firstUse("n1", now = 0, expiresAt = 1000))
    // Past expiry the timestamp check rejects it anyway; the cache just forgets.
    assertTrue(cache.firstUse("n1", now = 1001, expiresAt = 2001))
  }
}
