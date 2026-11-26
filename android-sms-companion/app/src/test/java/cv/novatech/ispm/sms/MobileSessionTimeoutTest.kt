package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class MobileSessionTimeoutTest {
  @Test fun expiresOnlyAfterFifteenMinutesInBackground() {
    assertFalse(MobileSessionTimeout.expired(1000L, 900999L))
    assertTrue(MobileSessionTimeout.expired(1000L, 901000L))
    assertTrue(MobileSessionTimeout.expired(1000L, 999L))
  }
}
