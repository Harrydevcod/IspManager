package cv.novatech.ispm.sms.send

import android.content.Context
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min

/** The last day of sends and the SIMs the carrier asked to rest. Survives restarts. */
class SendLogStore(context: Context) {
  private val prefs = context.getSharedPreferences("send_log", Context.MODE_PRIVATE)

  @Synchronized fun log(now: Long = System.currentTimeMillis()): List<Sent> = SendBudget.prune(decode(prefs.getString("rows", "[]") ?: "[]"), now)

  @Synchronized fun record(sent: Sent) {
    val rows = log(sent.at) + sent
    prefs.edit().putString("rows", JSONArray().apply {
      rows.forEach { put(JSONObject().put("sim", it.sim).put("at", it.at).put("parts", it.parts).put("id", it.requestId)) }
    }.toString()).commit()
  }

  @Synchronized fun paused(now: Long = System.currentTimeMillis()): Map<Int, Long> {
    val o = runCatching { JSONObject(prefs.getString("paused", "{}") ?: "{}") }.getOrDefault(JSONObject())
    return o.keys().asSequence().mapNotNull { k -> k.toIntOrNull()?.let { it to o.optLong(k) } }.filter { it.second > now }.toMap()
  }

  /** The carrier refused with "limit exceeded": the SIM that sent [requestId] rests. */
  @Synchronized fun pauseSimOf(requestId: String, now: Long = System.currentTimeMillis()) {
    val sim = log(now).lastOrNull { it.requestId == requestId }?.sim ?: return
    val o = JSONObject().apply { paused(now).forEach { (k, v) -> put(k.toString(), v) } }
    o.put(sim.toString(), now + SendBudget.CARRIER_PAUSE)
    prefs.edit().putString("paused", o.toString()).commit()
  }

  private fun decode(raw: String): List<Sent> = runCatching {
    val a = JSONArray(raw)
    (0 until a.length()).map { i -> a.getJSONObject(i).let { Sent(it.getInt("sim"), it.getLong("at"), it.getInt("parts"), it.optString("id")) } }
  }.getOrDefault(emptyList())
}

/**
 * One send at a time, each when its SIM has room. The request stays "approved"
 * while it waits, so a process death puts it back in the queue (RequestRules.recover)
 * instead of failing it; undoing it cancels the wait.
 */
class SendScheduler(
  private val store: SendLogStore,
  private val sims: () -> List<Int>,
  private val limits: () -> SimLimits,
  private val partsOf: (String) -> Int,
  /** null = sending now (or no longer waiting); 0 = queued behind another; else the time it can go. */
  private val onWait: (requestId: String, until: Long?) -> Unit,
  private val now: () -> Long = System::currentTimeMillis
) {
  private val mutex = Mutex()

  /** [go] sends on the chosen SIM and says whether it really did (the request may have been undone). */
  suspend fun dispatch(requestId: String, body: String, go: (sim: Int?) -> Boolean) {
    onWait(requestId, QUEUED)
    try {
      mutex.withLock {
        val parts = partsOf(body).coerceAtLeast(1)
        while (true) {
          val t = now()
          val (sim, at) = SendBudget.choose(store.log(t), sims(), parts, t, limits(), store.paused(t))
          if (at <= t) {
            onWait(requestId, null)
            if (go(sim.takeIf { it >= 0 })) store.record(Sent(sim, t, parts, requestId))
            return
          }
          onWait(requestId, at)
          // Re-check at least every minute: a setting may change, the other SIM may free up.
          delay(min(at - t, 60_000L))
        }
      }
    } finally {
      onWait(requestId, null)
    }
  }

  companion object {
    const val QUEUED = 0L
  }
}
