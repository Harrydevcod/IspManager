package cv.novatech.ispm.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NonceCacheTest {
  @Test fun replayInsideWindowIsRejected() {
    val cache = NonceCache(windowMs = 1000)
    assertTrue(cache.firstUse("n1", now = 0))
    assertFalse(cache.firstUse("n1", now = 500))
    assertTrue(cache.firstUse("n2", now = 500))
  }

  @Test fun expiredNoncesArePurged() {
    val cache = NonceCache(windowMs = 1000)
    assertTrue(cache.firstUse("n1", now = 0))
    // Past the window the signature's own timestamp check rejects it; the cache just forgets.
    assertTrue(cache.firstUse("n1", now = 2001))
  }
}
