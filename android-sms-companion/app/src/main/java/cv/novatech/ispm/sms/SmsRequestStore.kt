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
  val error: String?
)

/**
 * Durable store for incoming SMS requests. Requests survive process death so an
 * operator can approve them later, and the desktop can poll their status.
 */
class SmsRequestStore(context: Context) {
  private val prefs = context.getSharedPreferences("requests", Context.MODE_PRIVATE)

  fun list(): List<SmsRequest> {
    val raw = prefs.getString("rows", "[]") ?: "[]"
    val array = JSONArray(raw)
    return (0 until array.length()).map { i ->
      val obj = array.getJSONObject(i)
      SmsRequest(
        obj.getString("id"),
        obj.getString("toPhone"),
        obj.getString("body"),
        obj.getString("eventType"),
        obj.getString("status"),
        obj.optString("error").ifBlank { null }
      )
    }
  }

  fun upsert(request: SmsRequest) {
    val rows = list().filter { it.id != request.id } + request
    save(rows)
  }

  fun find(id: String): SmsRequest? = list().firstOrNull { it.id == id }

  fun updateStatus(id: String, status: String, error: String?) {
    save(list().map { if (it.id == id) it.copy(status = status, error = error) else it })
  }

  private fun save(rows: List<SmsRequest>) {
    val array = JSONArray()
    rows.forEach {
      array.put(
        JSONObject()
          .put("id", it.id)
          .put("toPhone", it.toPhone)
          .put("body", it.body)
          .put("eventType", it.eventType)
          .put("status", it.status)
          .put("error", it.error ?: "")
      )
    }
    prefs.edit().putString("rows", array.toString()).apply()
  }
}
