package cv.novatech.ispm.sms

import fi.iki.elonen.NanoHTTPD
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs

/**
 * Tiny authenticated HTTP server bound to the LAN. Every request must carry a
 * valid HMAC-SHA256 signature derived from the pairing secret, plus a fresh
 * timestamp to bound replay. The canonical string MUST match the desktop's
 * `createSmsSignature` (method\npath\ntimestamp\nnonce\nbody).
 */
class CompanionServer(
  private val pairingStore: PairingStore,
  private val requestStore: SmsRequestStore,
  port: Int = 8765,
  private val onRequestsChanged: (SmsRequest) -> Unit = {}
) : NanoHTTPD(port) {

  override fun serve(session: IHTTPSession): Response {
    val bodyMap = HashMap<String, String>()
    try {
      session.parseBody(bodyMap)
    } catch (_: Exception) {
      // GET requests and empty bodies are fine; signature still covers "".
    }
    val body = bodyMap["postData"] ?: ""
    if (!verify(session, body)) {
      return json(Response.Status.UNAUTHORIZED, """{"error":"assinatura invalida"}""")
    }

    if (session.method == Method.POST && session.uri == "/requests") {
      val json = org.json.JSONObject(body)
      val id = json.getString("requestId")
      val request = SmsRequest(
        id = id,
        toPhone = json.getString("toPhone"),
        body = json.getString("body"),
        eventType = json.optString("eventType", "test"),
        status = "pending_approval",
        error = null,
        clientName = if (json.has("clientName") && !json.isNull("clientName")) json.optString("clientName").ifBlank { null } else null
      )
      requestStore.upsert(request)
      onRequestsChanged(request)
      return json(Response.Status.OK, """{"id":"$id","status":"pending_approval"}""")
    }

    if (session.method == Method.GET && session.uri.startsWith("/requests/")) {
      val id = session.uri.removePrefix("/requests/")
      val row = requestStore.find(id)
        ?: return json(Response.Status.NOT_FOUND, """{"error":"pedido nao encontrado"}""")
      return json(Response.Status.OK, """{"id":"${row.id}","status":"${row.status}","error":"${row.error ?: ""}"}""")
    }

    return json(Response.Status.NOT_FOUND, """{"error":"rota inexistente"}""")
  }

  private fun json(status: Response.Status, payload: String): Response =
    newFixedLengthResponse(status, "application/json", payload)

  private fun verify(session: IHTTPSession, body: String): Boolean {
    val secret = pairingStore.secret()
    if (secret.isBlank()) return false
    val timestamp = session.headers["x-ispm-timestamp"] ?: return false
    val nonce = session.headers["x-ispm-nonce"] ?: return false
    val signature = session.headers["x-ispm-signature"] ?: return false

    // Bound replay to a 5 minute clock skew window.
    val sentAt = parseIso(timestamp) ?: return false
    if (abs(System.currentTimeMillis() - sentAt) > 5 * 60_000) return false

    val canonical = listOf(session.method.name, session.uri, timestamp, nonce, body).joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    val expected = mac.doFinal(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return constantTimeEquals(expected, signature)
  }

  private fun parseIso(value: String): Long? = try {
    java.time.Instant.parse(value).toEpochMilli()
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
