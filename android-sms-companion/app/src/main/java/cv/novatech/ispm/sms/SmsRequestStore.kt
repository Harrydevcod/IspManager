package cv.novatech.ispm.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class SmsRequest(
  val id: String,
  val toPhone: String,
  val body: String,
  val eventType: String,
  val status: String,
  val error: String?,
  val clientName: String? = null,
  val createdAt: Long? = null,
  val updatedAt: Long? = null,
  val approvedAt: Long? = null,
  val sentAt: Long? = null,
  val deliveredAt: Long? = null
)

/**
 * Durable store for incoming SMS requests. Requests survive process death so an
 * operator can approve them later, and the desktop can poll their status.
 * The HTTP server thread, the UI and the SMS result receiver all write here, so
 * every read-modify-write is synchronized.
 */
class SmsRequestStore(context: Context) {
  private val prefs = context.getSharedPreferences("requests", Context.MODE_PRIVATE)

  @Synchronized fun list(): List<SmsRequest> = decode(prefs.getString("rows", "[]") ?: "[]")

  @Synchronized fun upsert(request: SmsRequest) {
    save(list().filter { it.id != request.id } + request)
  }

  @Synchronized fun find(id: String): SmsRequest? = list().firstOrNull { it.id == id }

  /** Applies [change] to one row and returns the new row (null if absent). */
  @Synchronized fun update(id: String, change: (SmsRequest) -> SmsRequest): SmsRequest? {
    var updated: SmsRequest? = null
    save(list().map { if (it.id == id) change(it).also { n -> updated = n } else it })
    return updated
  }

  fun updateStatus(id: String, status: String, error: String?) {
    update(id) { it.copy(status = status, error = error, updatedAt = System.currentTimeMillis()) }
  }

  /** Replaces all rows in one write (used by prune/recover on start). */
  @Synchronized fun replaceAll(transform: (List<SmsRequest>) -> List<SmsRequest>) {
    save(transform(list()))
  }

  private fun save(rows: List<SmsRequest>) {
    val array = JSONArray()
    rows.forEach { array.put(encode(it)) }
    // commit(): a SENT broadcast may be the last thing the process does.
    prefs.edit().putString("rows", array.toString()).commit()
  }

  companion object {
    fun encode(r: SmsRequest): JSONObject = JSONObject()
      .put("id", r.id)
      .put("toPhone", r.toPhone)
      .put("body", r.body)
      .put("eventType", r.eventType)
      .put("status", r.status)
      .put("error", r.error ?: "")
      .put("clientName", r.clientName ?: "")
      .put("createdAt", r.createdAt ?: 0L)
      .put("updatedAt", r.updatedAt ?: 0L)
      .put("approvedAt", r.approvedAt ?: 0L)
      .put("sentAt", r.sentAt ?: 0L)
      .put("deliveredAt", r.deliveredAt ?: 0L)

    /** Rows written by 0.1.0 have no timestamps; they read back as null. */
    fun decode(raw: String): List<SmsRequest> {
      val array = JSONArray(raw)
      return (0 until array.length()).map { i ->
        val o = array.getJSONObject(i)
        SmsRequest(
          id = o.getString("id"),
          toPhone = o.getString("toPhone"),
          body = o.getString("body"),
          eventType = o.getString("eventType"),
          status = o.getString("status"),
          error = o.optString("error").ifBlank { null },
          clientName = if (o.has("clientName") && !o.isNull("clientName")) o.optString("clientName").ifBlank { null } else null,
          createdAt = o.optTime("createdAt"),
          updatedAt = o.optTime("updatedAt"),
          approvedAt = o.optTime("approvedAt"),
          sentAt = o.optTime("sentAt"),
          deliveredAt = o.optTime("deliveredAt")
        )
      }
    }

    private fun JSONObject.optTime(key: String): Long? = optLong(key, 0L).takeIf { it > 0L }
  }
}
