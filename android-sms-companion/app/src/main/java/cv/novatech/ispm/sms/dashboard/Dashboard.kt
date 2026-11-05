package cv.novatech.ispm.sms.dashboard

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.time.Instant

/**
 * The desktop's Painel snapshot (contract: src/backend/lib/companion-snapshot.ts,
 * schemaVersion 1). Parsed defensively: a missing field becomes a neutral value,
 * never a crash, so an older desktop can't take the screen down. Fields are only
 * ever added under schema 1; [hasFieldData] says whether this desktop sends the
 * Terreno lists at all (ISPM 2.53+), so the app can say "atualize o ISPM".
 */
data class Dashboard(
  val generatedAt: String,
  val companyName: String,
  val operation: Operation,
  val money: Money,
  val network: Network,
  val customers: Customers,
  val sms: Sms,
  val work: Work = Work(emptyList(), emptyList()),
  val hasFieldData: Boolean = false
) {
  data class Item(val title: String, val detail: String, val severity: String)
  data class Operation(val severity: String, val headline: String, val risks: List<Item>, val actions: List<Item>)
  data class Debtor(
    val clientName: String,
    val amountCve: Long,
    val daysOverdue: Int,
    val clientCode: String = "",
    /** Ready to dial (+238…), null when the record has no valid number. */
    val phone: String? = null
  )
  data class AccountAmount(val name: String, val amountCve: Long)
  data class CashToday(val totalCve: Long, val byAccount: List<AccountAmount>)
  data class MonthAmount(val month: String, val amountCve: Long)
  data class Money(
    val paidMonthCve: Long,
    val paidPrevMonthCve: Long,
    val pendingMonthCve: Long,
    val pendingMonthCount: Int,
    val pendingPreviousCve: Long,
    val overduePayments: Int,
    val criticalOverdue: List<Debtor>,
    val debtors: List<Debtor> = emptyList(),
    val cashToday: CashToday = CashToday(0, emptyList()),
    val monthlyReceipts: List<MonthAmount> = emptyList()
  )
  data class Down(val name: String, val since: String, val kind: String = "", val id: Long = 0) {
    /** Identity across snapshots; an older desktop sends no id, so the name stands in. */
    val key: String get() = if (id > 0) "$kind:$id" else "name:$name"
  }
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
  data class WorkOrder(
    val id: Long, val title: String, val priority: String, val scheduledAt: String?, val assignedTo: String?,
    val clientName: String?, val phone: String?, val address: String?, val zone: String?, val island: String?
  )
  data class Ticket(val id: Long, val subject: String, val priority: String, val openedAt: String, val clientName: String, val phone: String?)
  data class Work(val orders: List<WorkOrder>, val tickets: List<Ticket>)

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
          },
          debtors = money.optJSONArray("debtors").items {
            Debtor(it.optString("clientName"), it.optLong("amountCve"), it.optInt("daysOverdue"), it.optString("clientCode"), it.optStringOrNull("phone"))
          },
          cashToday = (money.optJSONObject("cashToday") ?: JSONObject()).let { c ->
            CashToday(c.optLong("totalCve"), c.optJSONArray("byAccount").items { AccountAmount(it.optString("name"), it.optLong("amountCve")) })
          },
          monthlyReceipts = money.optJSONArray("monthlyReceipts").items { MonthAmount(it.optString("month"), it.optLong("amountCve")) }
        ),
        network = Network(
          tone = net.optString("tone", "ok"),
          downCount = net.optInt("downCount"),
          downNow = net.optJSONArray("downNow").items { Down(it.optString("name"), it.optString("since"), it.optString("kind"), it.optLong("id")) },
          findingsCount = net.optInt("findingsCount"),
          wans = if (net.isNull("wans")) null else net.optJSONArray("wans").items {
            Wan(it.optString("name"), it.optBoolean("running"), it.optLongOrNull("downBps"), it.optLongOrNull("upBps"))
          },
          wanReason = net.optStringOrNull("wanReason")
        ),
        customers = Customers(cust.optInt("total"), cust.optInt("active"), cust.optInt("suspended"), cust.optInt("openWorkOrders"), cust.optInt("openTickets")),
        sms = Sms(counts(sms.optJSONObject("today")), counts(sms.optJSONObject("month"))),
        work = (o.optJSONObject("work") ?: JSONObject()).let { w ->
          Work(
            orders = w.optJSONArray("orders").items {
              WorkOrder(
                it.optLong("id"), it.optString("title"), it.optString("priority", "media"), it.optStringOrNull("scheduledAt"),
                it.optStringOrNull("assignedTo"), it.optStringOrNull("clientName"), it.optStringOrNull("phone"),
                it.optStringOrNull("address"), it.optStringOrNull("zone"), it.optStringOrNull("island")
              )
            },
            tickets = w.optJSONArray("tickets").items {
              Ticket(it.optLong("id"), it.optString("subject"), it.optString("priority", "media"), it.optString("openedAt"), it.optString("clientName"), it.optStringOrNull("phone"))
            }
          )
        },
        hasFieldData = money.has("debtors") && o.has("work")
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

/** What changed in the network between two snapshots. */
data class NetworkChanges(val wentDown: List<Dashboard.Down>, val restored: List<Restored>) {
  data class Restored(val down: Dashboard.Down, val minutesDown: Long?)
  val count: Int get() = wentDown.size + restored.size
}

object FieldRules {
  /** More changes than this in one snapshot become a single summary notification. */
  const val MAX_SINGLE_ALERTS = 3

  /**
   * Compares the down lists of two snapshots. No previous snapshot means no
   * alerts: the first sync after install must not announce every old outage.
   */
  fun networkChanges(previous: List<Dashboard.Down>?, next: List<Dashboard.Down>, now: Long): NetworkChanges {
    if (previous == null) return NetworkChanges(emptyList(), emptyList())
    // Across a desktop upgrade one side has ids and the other doesn't: compare by
    // name then, or every outage would be announced as "caiu" and "voltou" at once.
    val byName = (previous + next).any { it.id <= 0 }
    val key: (Dashboard.Down) -> String = { if (byName) "name:${it.name}" else it.key }
    val before = previous.map(key).toSet()
    val after = next.map(key).toSet()
    val wentDown = next.filter { key(it) !in before }
    val restored = previous.filter { key(it) !in after }.map { d ->
      NetworkChanges.Restored(d, parseInstant(d.since)?.let { ((now - it) / 60_000).coerceAtLeast(0) })
    }
    return NetworkChanges(wentDown, restored)
  }

  /** Accepts ISO-8601 and SQLite's "YYYY-MM-DD HH:MM:SS" (UTC). */
  fun parseInstant(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
    ?: runCatching { Instant.parse(value.trim().replace(' ', 'T') + "Z").toEpochMilli() }.getOrNull()

  fun dialUri(phone: String) = "tel:$phone"
  fun smsUri(phone: String) = "smsto:$phone"
  /** wa.me wants the number without "+" or spaces. */
  fun whatsappUrl(phone: String) = "https://wa.me/" + phone.filter { it.isDigit() }

  /** Maps search for the client's address; null when there is nothing to search. */
  fun mapsUri(address: String?, zone: String?, island: String?): String? {
    val parts = listOfNotNull(address, zone, island).map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.isEmpty()) return null
    val query = (parts + "Cabo Verde").joinToString(", ")
    return "geo:0,0?q=" + URLEncoder.encode(query, "UTF-8").replace("+", "%20")
  }
}
