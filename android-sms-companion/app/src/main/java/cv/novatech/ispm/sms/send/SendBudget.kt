package cv.novatech.ispm.sms.send

import kotlin.math.max

/**
 * How fast each SIM may send. Carriers allow roughly 30–200 SMS per hour and
 * can block a SIM above that; Android also refuses bursts. The defaults stay at
 * the low end: a blocked SIM costs far more than a slower batch of reminders.
 * A long SMS counts once per part, as the carrier counts it.
 */
data class SimLimits(val perHour: Int = 30, val perDay: Int = 200, val minGapMs: Long = 3_000) {
  companion object {
    val PRESETS = listOf(
      "Prudente" to SimLimits(30, 200),
      "Normal" to SimLimits(60, 400),
      "Rápido" to SimLimits(100, 800)
    )
  }
}

/** One send on the record: which SIM (-1 = the phone's default), when, how many parts, for which request. */
data class Sent(val sim: Int, val at: Long, val parts: Int, val requestId: String = "")

/** A SIM's use in the current windows, for the screen and the desktop. */
data class SimUsage(val sim: Int, val usedHour: Int, val usedDay: Int, val pausedUntil: Long?)

object SendBudget {
  const val HOUR = 3_600_000L
  const val DAY = 86_400_000L
  /** After the carrier says "limit exceeded", that SIM rests this long. */
  const val CARRIER_PAUSE = HOUR
  /** Settings value meaning "alternate between the SIMs". */
  const val ROTATE = -2
  const val DEFAULT_SIM = -1

  private fun used(log: List<Sent>, sim: Int, now: Long, window: Long) =
    log.filter { it.sim == sim && it.at > now - window }.sumOf { it.parts }

  fun usage(log: List<Sent>, sim: Int, now: Long, pausedUntil: Long?) =
    SimUsage(sim, used(log, sim, now, HOUR), used(log, sim, now, DAY), pausedUntil?.takeIf { it > now })

  /** Earliest moment at or after [from] when [parts] more fit in [cap] within [window]. */
  private fun windowSlot(entries: List<Sent>, parts: Int, cap: Int, window: Long, from: Long): Long {
    // ponytail: a message longer than the whole cap goes alone rather than never.
    if (parts > cap) return from
    val inWindow = entries.filter { it.at > from - window }.sortedBy { it.at }
    var load = inWindow.sumOf { it.parts }
    if (load + parts <= cap) return from
    for (e in inWindow) {
      load -= e.parts
      if (load + parts <= cap) return e.at + window
    }
    return from
  }

  /**
   * When [sim] may send [parts] parts: after its pause, after the last send on any
   * SIM plus the gap (Android limits the radio, not a SIM), and inside both windows.
   */
  fun nextSlot(log: List<Sent>, sim: Int, parts: Int, now: Long, limits: SimLimits, pausedUntil: Long?): Long {
    var t = max(now, pausedUntil ?: 0)
    log.maxOfOrNull { it.at }?.let { t = max(t, it + limits.minGapMs) }
    val mine = log.filter { it.sim == sim }
    // The day window can push past an hour slot and vice versa: settle on a time both accept.
    repeat(3) {
      t = max(t, windowSlot(mine, parts, limits.perHour, HOUR, t))
      t = max(t, windowSlot(mine, parts, limits.perDay, DAY, t))
    }
    return t
  }

  /** The SIM that can send soonest; on a tie, the one used least this hour (so they alternate). */
  fun choose(log: List<Sent>, sims: List<Int>, parts: Int, now: Long, limits: SimLimits, paused: Map<Int, Long>): Pair<Int, Long> =
    sims.ifEmpty { listOf(DEFAULT_SIM) }
      .map { sim -> Triple(sim, nextSlot(log, sim, parts, now, limits, paused[sim]), used(log, sim, now, HOUR)) }
      .minWith(compareBy({ it.second }, { it.third }))
      .let { it.first to it.second }

  /** Nothing older than a day matters. */
  fun prune(log: List<Sent>, now: Long) = log.filter { it.at > now - DAY }
}
