package cv.novatech.ispm.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockRulesTest {
  private val now = 10 * 60_000L

  @Test fun aNewProcessStartsLocked() {
    assertTrue(LockRules.mustLock(enabled = true, deviceSecure = true, unlocked = false, backgroundAt = null, now = now))
  }

  @Test fun shortTripsOutDoNotLock() {
    assertFalse(LockRules.mustLock(true, true, unlocked = true, backgroundAt = now - 60_000, now = now))
    assertFalse(LockRules.mustLock(true, true, unlocked = true, backgroundAt = null, now = now))
  }

  @Test fun twoMinutesAwayLocks() {
    assertTrue(LockRules.mustLock(true, true, unlocked = true, backgroundAt = now - LockRules.GRACE_MS, now = now))
  }

  @Test fun offOrWithoutAScreenLockNeverLocks() {
    assertFalse(LockRules.mustLock(enabled = false, deviceSecure = true, unlocked = false, backgroundAt = null, now = now))
    // No PIN on the phone: locking would shut the operator out of their own app.
    assertFalse(LockRules.mustLock(enabled = true, deviceSecure = false, unlocked = false, backgroundAt = null, now = now))
  }
}
