package cv.novatech.ispm.sms

import cv.novatech.ispm.sms.events.EventStore
import cv.novatech.ispm.sms.events.FieldEventCodec
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.DataInputStream
import java.io.InputStream
import java.time.Instant
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs

/**
 * Tiny authenticated HTTP server bound to the LAN. Every request must carry a
 * valid HMAC-SHA256 signature derived from the pairing secret, a fresh
 * timestamp, and a nonce not seen in the last 5 minutes. The canonical string
 * MUST match the desktop's `createSmsSignature` (method\npath\ntimestamp\nnonce\nbody).
 */
class CompanionServer(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  port: Int = 8765,
  private val nonces: NonceCache = NonceCache(),
  private val onRequestsChanged: (SmsRequest) -> Unit = {},
  private val statusProvider: () -> JSONObject = { JSONObject() },
  private val onDashboard: (String) -> Boolean = { false },
  /** A request signed with the current secret: the desktop is really linked. */
  private val onAuthenticated: () -> Unit = {},
  /** A signed request that failed: the desktop holds another pairing. */
  private val onRejected: () -> Unit = {},
  /** Field events waiting for the desktop (canal de volta, 0.7.0+). */
  private val eventStore: EventStore? = null
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    // Refuse oversized bodies before reading them: this check runs unauthenticated.
    val length = session.headers["content-length"]?.toLongOrNull() ?: 0L
    if (length > MAX_BODY_BYTES) {
      return json(Response.Status.BAD_REQUEST, JSONObject().put("error", "pedido demasiado grande"))
    }
    val body = try {
      readBody(session.inputStream, length)
    } catch (_: Exception) {
      return json(Response.Status.BAD_REQUEST, JSONObject().put("error", "corpo incompleto"))
    }
    if (!verify(session, body)) {
      if (session.headers.containsKey("x-ispm-signature")) onRejected()
      return json(Response.Status.UNAUTHORIZED, JSONObject().put("error", "assinatura invalida"))
    }
    onAuthenticated()

    return try {
      route(session, body)
    } catch (e: Exception) {
      json(Response.Status.BAD_REQUEST, JSONObject().put("error", e.message ?: "pedido invalido"))
    }
  }

  private fun route(session: IHTTPSession, body: String): Response {
    if (session.method == Method.GET && session.uri == "/status") {
      return json(Response.Status.OK, statusProvider())
    }

    if (session.method == Method.POST && session.uri == "/dashboard") {
      return if (onDashboard(body)) json(Response.Status.OK, JSONObject().put("ok", true))
      else json(Response.Status.BAD_REQUEST, JSONObject().put("error", "resumo invalido"))
    }

    if (session.method == Method.POST && session.uri == "/requests") {
      val json = JSONObject(body)
      val id = json.getString("requestId")
      // A retried POST must not reset a request the operator already acted on.
      val existing = requestStore.find(id)
      if (existing != null) {
        return json(Response.Status.OK, JSONObject().put("id", id).put("status", RequestRules.desktopStatus(existing.status)))
      }
      val now = System.currentTimeMillis()
      val request = SmsRequest(
        id = id,
        toPhone = json.getString("toPhone"),
        body = json.getString("body"),
        eventType = json.optString("eventType", "test"),
        status = "pending_approval",
        error = null,
        clientName = if (json.has("clientName") && !json.isNull("clientName")) json.optString("clientName").ifBlank { null } else null,
        createdAt = now,
        updatedAt = now
      )
      requestStore.upsert(request)
      onRequestsChanged(request)
      return json(Response.Status.OK, JSONObject().put("id", id).put("status", "pending_approval"))
    }

    if (eventStore != null && session.method == Method.GET && session.uri == "/events") {
      return signed(session, "application/json", FieldEventCodec.forDesktop(eventStore.pending()).toString().toByteArray(Charsets.UTF_8))
    }

    if (eventStore != null && session.method == Method.POST && session.uri == "/events/ack") {
      eventStore.ack(FieldEventCodec.ackIds(body))
      return json(Response.Status.OK, JSONObject().put("ok", true))
    }

    if (eventStore != null && session.method == Method.GET && session.uri.startsWith("/media/")) {
      val file = eventStore.media(session.uri.removePrefix("/media/"))
        ?: return json(Response.Status.NOT_FOUND, JSONObject().put("error", "foto inexistente"))
      return signed(session, "image/jpeg", file.readBytes())
    }

    if (session.method == Method.GET && session.uri.startsWith("/requests/")) {
      val id = session.uri.removePrefix("/requests/")
      val row = requestStore.find(id)
        ?: return json(Response.Status.NOT_FOUND, JSONObject().put("error", "pedido nao encontrado"))
      return json(Response.Status.OK, statusJson(row))
    }

    return json(Response.Status.NOT_FOUND, JSONObject().put("error", "rota inexistente"))
  }

  private fun statusJson(row: SmsRequest): JSONObject = JSONObject()
    .put("id", row.id)
    .put("status", RequestRules.desktopStatus(row.status))
    .put("error", row.error ?: "")
    .put("sentAt", row.sentAt?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
    .put("deliveredAt", row.deliveredAt?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)

  /**
   * A response the desktop writes to its database from: signed over the request's
   * nonce and the body, so nothing else on the LAN can answer in the phone's place.
   */
  private fun signed(session: IHTTPSession, mime: String, bytes: ByteArray): Response {
    val nonce = session.headers["x-ispm-nonce"].orEmpty()
    return newFixedLengthResponse(Response.Status.OK, mime, bytes.inputStream(), bytes.size.toLong()).apply {
      addHeader("x-ispm-response-signature", ResponseSignature.sign(pairingStore.secret(), nonce, bytes))
    }
  }

  private fun json(status: Response.Status, payload: JSONObject): Response =
    newFixedLengthResponse(status, "application/json", payload.toString())

  private fun verify(session: IHTTPSession, body: String): Boolean {
    val secret = pairingStore.secret()
    if (secret.isBlank()) return false
    val timestamp = session.headers["x-ispm-timestamp"] ?: return false
    val nonce = session.headers["x-ispm-nonce"] ?: return false
    val signature = session.headers["x-ispm-signature"] ?: return false

    // Bound replay to a 5 minute clock skew window.
    val now = System.currentTimeMillis()
    val sentAt = parseIso(timestamp) ?: return false
    if (abs(now - sentAt) > SKEW_MS) return false

    val canonical = listOf(session.method.name, session.uri, timestamp, nonce, body).joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    val expected = mac.doFinal(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    // Nonce is recorded only after the signature checks out, so garbage can't fill the cache.
    // The nonce must outlive the timestamp's acceptance window, which ends at sentAt + SKEW_MS.
    return constantTimeEquals(expected, signature) && nonces.firstUse(nonce, now, sentAt + SKEW_MS)
  }

  private companion object {
    const val SKEW_MS = 5 * 60_000L
    // The Painel snapshot is the largest payload (cap 256 KB); SMS requests are tiny.
    const val MAX_BODY_BYTES = 300 * 1024L
  }

  private fun parseIso(value: String): Long? = try {
    Instant.parse(value).toEpochMilli()
  } catch (_: Exception) {
    null
  }

  private fun constantTimeEquals(a: String, b: String): Boolean {
    if (a.length != b.length) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
    return diff == 0
  }
}

/**
 * The raw body as UTF-8. NanoHTTPD's parseBody decodes it as US-ASCII when the
 * Content-Type has no charset (the desktop sends plain `application/json`), so any
 * accent in a client name broke the HMAC and the Painel snapshot never arrived.
 */
internal fun readBody(input: InputStream, length: Long): String {
  if (length <= 0) return ""
  val bytes = ByteArray(length.toInt())
  DataInputStream(input).readFully(bytes)
  return String(bytes, Charsets.UTF_8)
}

/** Same canonical form as the desktop's createResponseSignature (src/backend/lib/sms-signing.ts). */
object ResponseSignature {
  fun sign(secret: String, nonce: String, body: ByteArray): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal("response\n$nonce\n$digest".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }
}
