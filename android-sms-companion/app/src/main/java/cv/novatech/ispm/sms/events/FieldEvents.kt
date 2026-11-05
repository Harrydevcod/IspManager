package cv.novatech.ispm.sms.events

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * Something done in the field that the desktop must know: a work order closed,
 * cash received at the door, a client's SMS reply. Kept here until the desktop
 * pulls it (`GET /events`) and confirms it stored it (`POST /events/ack`); the
 * desktop applies each id once, so a lost ack only means it is pulled again.
 */
data class FieldEvent(val id: String, val kind: String, val at: Long, val payloadJson: String) {
  val payload: JSONObject get() = JSONObject(payloadJson)

  companion object {
    const val WORK_ORDER_DONE = "work_order_done"
    const val RECEIPT_PROPOSAL = "receipt_proposal"
    const val SMS_IN = "sms_in"
  }
}

object FieldEventCodec {
  /** Ids the desktop accepts (src/backend/lib/companion-events.ts). */
  val ID = Regex("^[A-Za-z0-9-]{8,64}$")
  const val PULL_LIMIT = 50

  fun encode(events: List<FieldEvent>): String = JSONArray().apply {
    events.forEach { put(JSONObject().put("id", it.id).put("kind", it.kind).put("at", it.at).put("payload", JSONObject(it.payloadJson))) }
  }.toString()

  fun decode(raw: String): List<FieldEvent> = runCatching {
    val array = JSONArray(raw)
    (0 until array.length()).mapNotNull { i ->
      val o = array.optJSONObject(i) ?: return@mapNotNull null
      FieldEvent(o.getString("id"), o.getString("kind"), o.getLong("at"), o.getJSONObject("payload").toString())
    }
  }.getOrDefault(emptyList())

  /** `GET /events` body: oldest first, at most [PULL_LIMIT], dates in ISO like the rest of the contract. */
  fun forDesktop(events: List<FieldEvent>): JSONObject = JSONObject().put("events", JSONArray().apply {
    events.sortedBy { it.at }.take(PULL_LIMIT).forEach {
      put(JSONObject().put("id", it.id).put("kind", it.kind).put("at", Instant.ofEpochMilli(it.at).toString()).put("payload", JSONObject(it.payloadJson)))
    }
  })

  /** `POST /events/ack` body → the ids, ignoring anything that isn't one. */
  fun ackIds(body: String): Set<String> = runCatching {
    val array = JSONObject(body).getJSONArray("ids")
    (0 until array.length()).map { array.getString(it) }.filter { ID.matches(it) }.toSet()
  }.getOrDefault(emptySet())
}

/**
 * Durable queue of [FieldEvent]s plus their photos (app-private files). The HTTP
 * server thread and the UI both write, so every change is synchronized; the
 * flow lets the Terreno screen show what is still waiting for the PC.
 */
class EventStore(context: Context) {
  private val prefs = context.getSharedPreferences("field_events", Context.MODE_PRIVATE)
  private val mediaDir = File(context.filesDir, "field-media").apply { mkdirs() }
  private val _events = MutableStateFlow(load())
  val events: StateFlow<List<FieldEvent>> = _events

  private fun load() = FieldEventCodec.decode(prefs.getString("rows", "[]") ?: "[]")

  @Synchronized fun pending(): List<FieldEvent> = _events.value

  /** Queues an event; photos are stored first and referenced by id in the payload. */
  @Synchronized fun add(kind: String, payload: JSONObject, photos: List<ByteArray> = emptyList(), now: Long = System.currentTimeMillis()): FieldEvent {
    val ids = photos.map { bytes -> UUID.randomUUID().toString().also { File(mediaDir, "$it.jpg").writeBytes(bytes) } }
    if (ids.isNotEmpty()) payload.put("photos", JSONArray(ids))
    val event = FieldEvent(UUID.randomUUID().toString(), kind, now, payload.toString())
    save(_events.value + event)
    return event
  }

  /** The desktop has these: forget them and their photos. */
  @Synchronized fun ack(ids: Set<String>) {
    val (gone, kept) = _events.value.partition { it.id in ids }
    gone.forEach { e -> e.payload.optJSONArray("photos")?.let { arr -> (0 until arr.length()).forEach { media(arr.getString(it))?.delete() } } }
    save(kept)
  }

  /** A queued photo, or null; the id is checked so a request can't walk the filesystem. */
  fun media(id: String): File? = if (FieldEventCodec.ID.matches(id)) File(mediaDir, "$id.jpg").takeIf { it.isFile } else null

  private fun save(rows: List<FieldEvent>) {
    // commit(): the operator may close the app right after "Concluir".
    prefs.edit().putString("rows", FieldEventCodec.encode(rows)).commit()
    _events.value = rows
  }
}
