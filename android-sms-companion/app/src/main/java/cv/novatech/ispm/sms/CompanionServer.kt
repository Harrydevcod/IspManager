package cv.novatech.ispm.sms

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
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
  private val onDashboard: (String) -> Boolean = { false }
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    // Refuse oversized bodies before reading them: this check runs unauthenticated.
    val length = session.headers["content-length"]?.toLongOrNull() ?: 0L
    if (length > MAX_BODY_BYTES) {
      return json(Response.Status.BAD_REQUEST, JSONObject().put("error", "pedido demasiado grande"))
    }
    val bodyMap = HashMap<String, String>()
    try {
      session.parseBody(bodyMap)
    } catch (_: Exception) {
      // GET requests and empty bodies are fine; signature still covers "".
    }
    val body = bodyMap["postData"] ?: ""
    if (!verify(session, body)) {
      return json(Response.Status.UNAUTHORIZED, JSONObject().put("error", "assinatura invalida"))
    }

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
