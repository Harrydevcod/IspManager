package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.TrustManagerFactory
import kotlin.concurrent.thread

class MobileHttpClientTest {
  @Test fun reusesConnectionForTheSameIdentity() {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileHttpClientTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val server = (SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
      .serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    val identity = DesktopIdentity("192.168.1.20", server.localPort, MobileIdentityRules.certificatePem(cert.encoded)!!, fingerprint)
    var count = 0
    val worker = thread {
      try {
        server.accept().use { socket ->
          socket.soTimeout = 5000
          val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
          repeat(2) {
            if (reader.readLine().isNullOrEmpty()) return@thread
            while (!reader.readLine().isNullOrEmpty()) { }
            count++
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".toByteArray(Charsets.US_ASCII))
            socket.getOutputStream().flush()
          }
        }
      } catch (_: IOException) { }
    }
    try {
      val client = MobileHttpClient({ identity }, { MobileTlsKeyManager(key, cert) { true } }, { InetAddress.getByName("127.0.0.1") })
      assertEquals(200, client.execute("GET", "/health", emptyMap(), null).status)
      assertEquals(200, client.execute("GET", "/health", emptyMap(), null).status)
      assertEquals(2, count)
    } finally { server.close(); worker.join(6000) }
  }
  private fun withResponse(response: String, action: (MobileHttpClient, () -> Unit) -> Unit) {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileHttpClientTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val server = (SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
      .serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    var identity: DesktopIdentity? = DesktopIdentity("192.168.1.20", server.localPort, MobileIdentityRules.certificatePem(cert.encoded)!!, fingerprint)
    val worker = thread {
      try {
        server.accept().use { socket ->
          socket.soTimeout = 5000
          val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
          while (!reader.readLine().isNullOrEmpty()) { }
          socket.getOutputStream().write(response.toByteArray(Charsets.US_ASCII))
          socket.getOutputStream().flush()
        }
      } catch (_: IOException) { }
    }
    try {
      action(MobileHttpClient({ identity }, { MobileTlsKeyManager(key, cert) { identity != null } }, { InetAddress.getByName("127.0.0.1") })) { identity = null }
    } finally { server.close(); worker.join(6000) }
  }

  @Test fun refusesRedirectsAndOversizedResponses() {
    withResponse("HTTP/1.1 307 Temporary Redirect\r\nLocation: https://example.com\r\nContent-Length: 0\r\n\r\n") { client, _ ->
      assertThrows(IOException::class.java) { client.execute("GET", "/api/clients", emptyMap(), null) }
    }
    withResponse("HTTP/1.1 200 OK\r\nContent-Length: 16777217\r\n\r\n") { client, _ ->
      assertThrows(IOException::class.java) { client.execute("GET", "/api/clients", emptyMap(), null) }
    }
  }

  @Test fun refusesAnIdentityForgottenBeforeRequest() {
    withResponse("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n") { client, forget ->
      forget()
      assertThrows(IOException::class.java) { client.execute("GET", "/api/clients", emptyMap(), null) }
    }
  }

  @Test fun patchUsesMutualTlsAndPreservesBinaryResponse() {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileHttpClientTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val server = (SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
      .serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    val identity = DesktopIdentity("192.168.1.20", server.localPort, MobileIdentityRules.certificatePem(cert.encoded)!!, fingerprint)
    var requestLine = ""
    val worker = thread {
      server.accept().use { socket ->
        socket.soTimeout = 5000
        val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
        requestLine = reader.readLine()
        while (!reader.readLine().isNullOrEmpty()) { }
        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 3\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII) + byteArrayOf(0, 1, -1))
        socket.getOutputStream().flush()
      }
    }
    try {
      val client = MobileHttpClient({ identity }, { MobileTlsKeyManager(key, cert) { true } }, { InetAddress.getByName("127.0.0.1") })
      val result = client.execute("PATCH", "/api/clients/1", mapOf("Content-Type" to "application/json"), "{}".toByteArray())
      assertEquals(200, result.status)
      assertArrayEquals(byteArrayOf(0, 1, -1), result.body)
      assertEquals("PATCH /api/clients/1 HTTP/1.1", requestLine)
    } finally { server.close(); worker.join(6000) }
  }

  @Test fun rejectsExternalTargetsAndUnsafeHeadersBeforeConnecting() {
    val client = MobileHttpClient({ null }, { null })
    for (path in listOf("https://example.com/api", "//example.com/api", "/api/a\r\nX: bad", "/api/a#fragment")) {
      assertThrows(IOException::class.java) { client.execute("GET", path, emptyMap(), null) }
    }
    assertThrows(IOException::class.java) { client.execute("GET", "/api/clients", mapOf("Host" to "example.com"), null) }
  }

  @Test fun rejectsPathsThatNormalizeOutsideTheApiBeforeCheckingPairing() {
    val client = MobileHttpClient({ null }, { null })
    for (path in listOf("/api/../health", "/api/%2e%2e/health", "/api/./../health")) {
      val error = assertThrows(IOException::class.java) { client.execute("GET", path, emptyMap(), null) }
      assertEquals("Invalid request", error.message)
    }
  }

  @Test fun allowsOnlyGetForHealth() {
    val client = MobileHttpClient({ null }, { null })
    assertEquals("Desktop not paired", assertThrows(IOException::class.java) { client.execute("GET", "/health", emptyMap(), null) }.message)
    assertEquals("Invalid request", assertThrows(IOException::class.java) { client.execute("POST", "/health", emptyMap(), null) }.message)
  }

  @Test fun bridgeForwardsHealthThroughMutualTls() {
    withResponse("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}") { client, _ ->
      val handler = MobileBridgeHandler(client::execute)
      val response = handler.handle(MobileBridgeHandler.ORIGIN, true, """{"id":"1","method":"GET","path":"/health","headers":{},"body":""}""")!!
      val parsed = org.json.JSONObject(response)
      assertEquals(200, parsed.getInt("status"))
      assertEquals("{}", String(java.util.Base64.getDecoder().decode(parsed.getString("body"))))
    }
  }
}
