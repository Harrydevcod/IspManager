package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Test

class SyncRulesTest {
  private val t0 = 1_000_000L

  @Test fun nothingAskedIsIdle() {
    assertEquals(SyncPhase.IDLE, SyncRules.phase(null, t0, t0))
  }

  @Test fun waitsUntilTheSummaryArrives() {
    assertEquals(SyncPhase.WAITING, SyncRules.phase(t0, t0 - 60_000, t0 + 30_000))
    assertEquals(SyncPhase.WAITING, SyncRules.phase(t0, null, t0 + 30_000))
  }

  @Test fun aSummaryAfterTheRequestEndsTheWait() {
    assertEquals(SyncPhase.IDLE, SyncRules.phase(t0, t0 + 45_000, t0 + 50_000))
  }

  @Test fun threeMissedPollsIsNoAnswer() {
    assertEquals(SyncPhase.WAITING, SyncRules.phase(t0, null, t0 + SyncRules.WAIT_MS - 1))
    assertEquals(SyncPhase.NO_ANSWER, SyncRules.phase(t0, null, t0 + SyncRules.WAIT_MS))
  }
}
