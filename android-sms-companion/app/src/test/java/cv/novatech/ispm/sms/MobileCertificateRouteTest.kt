package cv.novatech.ispm.sms

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.lang.reflect.Proxy
import java.time.Instant
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class MobileCertificateRouteTest {
  private val secret = "ab".repeat(32)
  private class Pairing(var key: String, var pairingVersion: Int = 2) : CompanionPairing {
    private var record: String? = null
    private val registry = DesktopIdentityRegistry(object : DesktopIdentityRepository {
      override fun read() = record
      override fun write(value: String): Boolean { record = value; return true }
    }) { DesktopPairing(pairingVersion, key) }
    override fun secret() = key
    override fun version() = pairingVersion
    override fun saveRelayUrl(url: String) = Unit
    override fun registerDesktopIdentity(expectedSecret: String, host: String, port: Int, pem: String) =
      registry.register(expectedSecret, host, port, pem)
  }
  private val requests = object : CompanionRequests {
    override fun find(id: String): SmsRequest? = null
    override fun upsert(request: SmsRequest) = Unit
  }

  private fun session(method: NanoHTTPD.Method, nonce: String, key: String, signature: Boolean = true, path: String = MobileIdentityRules.CERTIFICATE_PATH, body: String = ""): NanoHTTPD.IHTTPSession {
    val timestamp = Instant.now().toString()
    val canonical = listOf(method.name, path, timestamp, nonce, body).joinToString("\n")
    val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key.toByteArray(), "HmacSHA256")) }
    val sig = mac.doFinal(canonical.toByteArray()).joinToString("") { "%02x".format(it) }
    val headers = mutableMapOf("x-ispm-timestamp" to timestamp, "x-ispm-nonce" to nonce)
    headers["content-length"] = body.toByteArray(Charsets.UTF_8).size.toString()
    if (signature) headers["x-ispm-signature"] = sig
    return Proxy.newProxyInstance(javaClass.classLoader, arrayOf(NanoHTTPD.IHTTPSession::class.java)) { _, called, _ ->
      when (called.name) {
        "getHeaders" -> headers
        "getMethod" -> method
        "getUri" -> path
        "getInputStream" -> ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
        else -> null
      }
    } as NanoHTTPD.IHTTPSession
  }

  @Test fun signsFreshLanProofAndRejectsReplayAndUnauthenticatedRequests() {
    val pairing = Pairing(secret)
    var generated = 0
    val server = CompanionServer(pairing, requests, mobileCertificate = { generated++; "CERTIFICATE" })
    val nonce = "11111111-2222-4333-8444-555555555555"
    val response = server.serve(session(NanoHTTPD.Method.GET, nonce, secret))
    val body = response.data.use { it.readBytes() }
    assertEquals(200, response.status.requestStatus)
    assertEquals("CERTIFICATE", JSONObject(String(body)).getString("certificatePem"))
    // Cross-language vector from the desktop's HMAC-SHA256 response verifier.
    assertEquals("f6133045ea3fb57fc407c34610485d89ad33ac9d88cc55e0dec2bcb5a1ec85b4", response.getHeader("x-ispm-response-signature"))
    assertEquals(401, server.serve(session(NanoHTTPD.Method.GET, nonce, secret)).status.requestStatus)
    assertEquals(401, server.serve(session(NanoHTTPD.Method.GET, UUID.randomUUID().toString(), secret, false)).status.requestStatus)
    assertEquals(1, generated)
  }

  @Test fun refusesRelayLegacyWrongMethodAndPairingChangedDuringCreation() {
    val pairing = Pairing(secret)
    var generated = 0
    val server = CompanionServer(pairing, requests, mobileCertificate = { generated++; pairing.key = "cd".repeat(32); "CERTIFICATE" })
    assertEquals(403, server.relayReply("GET", MobileIdentityRules.CERTIFICATE_PATH, "n", "").status)
    pairing.pairingVersion = 1
    assertEquals(403, server.serve(session(NanoHTTPD.Method.GET, UUID.randomUUID().toString(), secret)).status.requestStatus)
    pairing.pairingVersion = 2
    assertEquals(403, server.serve(session(NanoHTTPD.Method.POST, UUID.randomUUID().toString(), secret)).status.requestStatus)
    assertEquals(409, server.serve(session(NanoHTTPD.Method.GET, UUID.randomUUID().toString(), secret)).status.requestStatus)
    assertEquals(1, generated)
  }

  @Test fun keystoreFailureReturnsAnErrorWithoutAProof() {
    val pairing = Pairing(secret)
    val server = CompanionServer(pairing, requests, mobileCertificate = { throw IllegalStateException("keystore") })
    val response = server.serve(session(NanoHTTPD.Method.GET, UUID.randomUUID().toString(), secret))
    assertEquals(500, response.status.requestStatus)
    assertNull(response.getHeader("x-ispm-response-signature"))
  }

  @Test fun desktopIdentityRequiresSignedLocalPairingAndRefusesReplacement() {
    val pairing = Pairing(secret)
    val server = CompanionServer(pairing, requests)
    val path = MobileIdentityRules.DESKTOP_IDENTITY_PATH
    fun pem(name: String) = requireNotNull(javaClass.getResourceAsStream("/mobile-identity/$name.pem")).bufferedReader().use { it.readText() }
    fun payload(cert: String, host: String = "192.168.1.20") = JSONObject().put("host", host).put("port", 38421).put("certificatePem", cert).toString()
    val body = payload(pem("desktop-valid"))
    assertEquals(401, server.serve(session(NanoHTTPD.Method.POST, UUID.randomUUID().toString(), secret, false, path, body)).status.requestStatus)
    assertEquals(403, server.relayReply("POST", path, "n", body).status)
    pairing.pairingVersion = 1
    assertEquals(403, server.serve(session(NanoHTTPD.Method.POST, UUID.randomUUID().toString(), secret, true, path, body)).status.requestStatus)
    pairing.pairingVersion = 2
    val nonce = UUID.randomUUID().toString()
    val response = server.serve(session(NanoHTTPD.Method.POST, nonce, secret, true, path, body))
    val bytes = response.data.use { it.readBytes() }
    assertEquals(200, response.status.requestStatus)
    assertEquals(ResponseSignature.sign(secret, nonce, bytes), response.getHeader("x-ispm-response-signature"))
    assertEquals(200, server.serve(session(NanoHTTPD.Method.POST, UUID.randomUUID().toString(), secret, true, path, payload(pem("desktop-valid"), "192.168.1.21"))).status.requestStatus)
    assertEquals(409, server.serve(session(NanoHTTPD.Method.POST, UUID.randomUUID().toString(), secret, true, path, payload(pem("desktop-other-valid")))).status.requestStatus)
  }
}
