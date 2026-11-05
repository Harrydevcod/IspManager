package cv.novatech.ispm.sms.send

import org.junit.Assert.assertEquals
import org.junit.Test

class SendBudgetTest {
  private val t0 = 1_000_000_000L
  private val limits = SimLimits(perHour = 3, perDay = 5, minGapMs = 3_000)

  @Test fun emptyLogSendsNow() {
    assertEquals(t0, SendBudget.nextSlot(emptyList(), 1, 1, t0, limits, null))
  }

  @Test fun keepsTheGapBetweenSendsEvenAcrossSims() {
    val log = listOf(Sent(2, t0 - 1_000, 1))
    assertEquals(t0 + 2_000, SendBudget.nextSlot(log, 1, 1, t0, limits, null))
  }

  @Test fun fullHourWaitsForTheOldestToLeave() {
    val log = listOf(Sent(1, t0 - 50 * 60_000, 1), Sent(1, t0 - 40 * 60_000, 1), Sent(1, t0 - 30 * 60_000, 1))
    // The send 50 min ago leaves the hour window 10 min from now.
    assertEquals(t0 - 50 * 60_000 + SendBudget.HOUR, SendBudget.nextSlot(log, 1, 1, t0, limits, null))
  }

  @Test fun eachPartCounts() {
    val log = listOf(Sent(1, t0 - 10 * 60_000, 2))
    // 2 used + 2 parts > 3: wait until that send leaves the hour.
    assertEquals(t0 - 10 * 60_000 + SendBudget.HOUR, SendBudget.nextSlot(log, 1, 2, t0, limits, null))
    assertEquals(t0, SendBudget.nextSlot(log, 1, 1, t0, limits, null))
  }

  @Test fun dayCapHoldsEvenWithRoomInTheHour() {
    val h = SendBudget.HOUR
    val log = (1..5).map { Sent(1, t0 - (2 + it) * h, 1) } // five sends, 3–7 h ago: hour is free, day is full
    val oldest = t0 - 7 * h
    assertEquals(oldest + SendBudget.DAY, SendBudget.nextSlot(log, 1, 1, t0, limits, null))
  }

  @Test fun carrierPauseIsRespected() {
    assertEquals(t0 + SendBudget.CARRIER_PAUSE, SendBudget.nextSlot(emptyList(), 1, 1, t0, limits, t0 + SendBudget.CARRIER_PAUSE))
  }

  @Test fun rotationPicksTheSimWithRoomAndAlternatesOnTies() {
    val busy = (1..3).map { Sent(1, t0 - it * 60_000L, 1) }
    assertEquals(2 to t0, SendBudget.choose(busy, listOf(1, 2), 1, t0, limits, emptyMap()))

    val oneEach = listOf(Sent(1, t0 - 120_000, 1))
    // Both can send now; SIM 2 has sent less this hour.
    assertEquals(2, SendBudget.choose(oneEach, listOf(1, 2), 1, t0, limits, emptyMap()).first)
  }

  @Test fun pausedSimIsSkippedWhenTheOtherCanSend() {
    assertEquals(2 to t0, SendBudget.choose(emptyList(), listOf(1, 2), 1, t0, limits, mapOf(1 to t0 + SendBudget.HOUR)))
  }

  @Test fun bothFullWaitsForTheFirstToFree() {
    val log = (1..3).map { Sent(1, t0 - (50 - it) * 60_000L, 1) } + (1..3).map { Sent(2, t0 - (40 - it) * 60_000L, 1) }
    val (sim, at) = SendBudget.choose(log, listOf(1, 2), 1, t0, limits, emptyMap())
    assertEquals(1, sim)
    assertEquals(t0 - 49 * 60_000L + SendBudget.HOUR, at)
  }

  @Test fun usageCountsPartsPerWindow() {
    val log = listOf(Sent(1, t0 - 10 * 60_000, 2), Sent(1, t0 - 3 * SendBudget.HOUR, 1), Sent(2, t0 - 60_000, 1))
    assertEquals(SimUsage(1, 2, 3, null), SendBudget.usage(log, 1, t0, t0 - 1))
  }
}
