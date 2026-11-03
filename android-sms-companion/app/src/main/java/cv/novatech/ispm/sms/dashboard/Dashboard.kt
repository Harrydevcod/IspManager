package cv.novatech.ispm.sms.dashboard

import org.json.JSONArray
import org.json.JSONObject

/**
 * The desktop's Painel snapshot (contract: src/backend/lib/companion-snapshot.ts,
 * schemaVersion 1). Parsed defensively: a missing field becomes a neutral value,
 * never a crash, so an older desktop can't take the screen down.
 */
data class Dashboard(
  val generatedAt: String,
  val companyName: String,
  val operation: Operation,
  val money: Money,
  val network: Network,
  val customers: Customers,
  val sms: Sms
) {
  data class Item(val title: String, val detail: String, val severity: String)
  data class Operation(val severity: String, val headline: String, val risks: List<Item>, val actions: List<Item>)
  data class Debtor(val clientName: String, val amountCve: Long, val daysOverdue: Int)
  data class Money(
    val paidMonthCve: Long,
    val paidPrevMonthCve: Long,
    val pendingMonthCve: Long,
    val pendingMonthCount: Int,
    val pendingPreviousCve: Long,
    val overduePayments: Int,
    val criticalOverdue: List<Debtor>
  )
  data class Down(val name: String, val since: String)
  data class Wan(val name: String, val running: Boolean, val downBps: Long?, val upBps: Long?)
  data class Network(
    val tone: String,
    val downCount: Int,
    val downNow: List<Down>,
    val findingsCount: Int,
    val wans: List<Wan>?,
    val wanReason: String?
  )
  data class Customers(val total: Int, val active: Int, val suspended: Int, val openWorkOrders: Int, val openTickets: Int)
  data class SmsCounts(val sent: Int, val delivered: Int, val failed: Int, val pending: Int)
  data class Sms(val today: SmsCounts, val month: SmsCounts)

  companion object {
    const val SCHEMA_VERSION = 1
    const val MAX_BYTES = 256 * 1024

    /** Null when the payload isn't a schema-1 snapshot. */
    fun parse(raw: String): Dashboard? = runCatching {
      val o = JSONObject(raw)
      if (o.optInt("schemaVersion") != SCHEMA_VERSION) return null
      val op = o.optJSONObject("operation") ?: JSONObject()
      val money = o.optJSONObject("money") ?: JSONObject()
      val net = o.optJSONObject("network") ?: JSONObject()
      val cust = o.optJSONObject("customers") ?: JSONObject()
      val sms = o.optJSONObject("sms") ?: JSONObject()
      Dashboard(
        generatedAt = o.optString("generatedAt"),
        companyName = o.optString("companyName", "ISPM"),
        operation = Operation(
          severity = op.optString("severity", "green"),
          headline = op.optString("headline"),
          risks = op.optJSONArray("risks").items { Item(it.optString("title"), it.optString("detail"), it.optString("severity", "amber")) },
          actions = op.optJSONArray("actions").items { Item(it.optString("title"), it.optString("detail"), it.optString("severity", "amber")) }
        ),
        money = Money(
          paidMonthCve = money.optLong("paidMonthCve"),
          paidPrevMonthCve = money.optLong("paidPrevMonthCve"),
          pendingMonthCve = money.optLong("pendingMonthCve"),
          pendingMonthCount = money.optInt("pendingMonthCount"),
          pendingPreviousCve = money.optLong("pendingPreviousCve"),
          overduePayments = money.optInt("overduePayments"),
          criticalOverdue = money.optJSONArray("criticalOverdue").items {
            Debtor(it.optString("clientName"), it.optLong("amountCve"), it.optInt("daysOverdue"))
          }
        ),
        network = Network(
          tone = net.optString("tone", "ok"),
          downCount = net.optInt("downCount"),
          downNow = net.optJSONArray("downNow").items { Down(it.optString("name"), it.optString("since")) },
          findingsCount = net.optInt("findingsCount"),
          wans = if (net.isNull("wans")) null else net.optJSONArray("wans").items {
            Wan(it.optString("name"), it.optBoolean("running"), it.optLongOrNull("downBps"), it.optLongOrNull("upBps"))
          },
          wanReason = net.optStringOrNull("wanReason")
        ),
        customers = Customers(cust.optInt("total"), cust.optInt("active"), cust.optInt("suspended"), cust.optInt("openWorkOrders"), cust.optInt("openTickets")),
        sms = Sms(counts(sms.optJSONObject("today")), counts(sms.optJSONObject("month")))
      )
    }.getOrNull()

    private fun counts(o: JSONObject?) = SmsCounts(o?.optInt("sent") ?: 0, o?.optInt("delivered") ?: 0, o?.optInt("failed") ?: 0, o?.optInt("pending") ?: 0)

    private fun <T> JSONArray?.items(map: (JSONObject) -> T): List<T> =
      if (this == null) emptyList() else (0 until length()).mapNotNull { i -> optJSONObject(i)?.let(map) }

    private fun JSONObject.optLongOrNull(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)
    private fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifBlank { null }
  }
}

enum class Freshness { NONE, FRESH, STALE }

object DashboardRules {
  /** The desktop pushes every 5 min; three missed pushes means the PC is off or away. */
  const val STALE_AFTER_MS = 15 * 60_000L

  fun freshness(receivedAt: Long?, now: Long): Freshness = when {
    receivedAt == null -> Freshness.NONE
    now - receivedAt > STALE_AFTER_MS -> Freshness.STALE
    else -> Freshness.FRESH
  }

  /** Alert only on the transition into red, not on every red snapshot. */
  fun shouldAlert(previousSeverity: String?, newSeverity: String): Boolean =
    newSeverity == "red" && previousSeverity != "red"

  /** CVE the way the project writes it: 1.500$00. */
  fun formatCve(value: Long): String {
    val digits = kotlin.math.abs(value).toString().reversed().chunked(3).joinToString(".").reversed()
    return (if (value < 0) "-" else "") + digits + "\$00"
  }

  fun formatBps(bps: Long?): String = when {
    bps == null -> "—"
    bps >= 1_000_000 -> String.format(java.util.Locale.ROOT, "%.1f Mb/s", bps / 1_000_000.0)
    bps >= 1_000 -> "${bps / 1_000} kb/s"
    else -> "$bps b/s"
  }

  fun ago(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return when {
      s < 60 -> "agora mesmo"
      s < 3600 -> "há ${s / 60} min"
      s < 48 * 3600 -> "há ${s / 3600} h"
      else -> "há ${s / 86400} dias"
    }
  }
}
