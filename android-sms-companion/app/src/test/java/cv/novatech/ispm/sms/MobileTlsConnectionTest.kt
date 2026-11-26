package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import kotlin.concurrent.thread

class MobileTlsConnectionTest {
  @Test fun refusesInvalidDesktopBeforeDialing() {
    val invalid = DesktopIdentity("127.0.0.1", 1234, "invalid", "invalid")
    var dialed = false
    val connection = MobileTlsConnection({ invalid }, { null }) { _, _, _ -> dialed = true; Socket() }
    assertThrows(java.io.IOException::class.java) { connection.use { } }
    assertFalse(dialed)
  }

  @Test fun healthProbeUsesTheMutuallyAuthenticatedConnection() {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileTlsConnectionTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val server = (SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }.serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    val identity = DesktopIdentity("192.168.1.20", server.localPort, MobileIdentityRules.certificatePem(cert.encoded)!!, fingerprint)
    val worker = thread {
      (server.accept() as SSLSocket).use { socket ->
        socket.soTimeout = 5000
        val reader = socket.inputStream.bufferedReader(Charsets.US_ASCII)
        check(reader.readLine() == "GET /health HTTP/1.1")
        while (!reader.readLine().isNullOrEmpty()) { }
        val body = """{"ok":true,"service":"ispm-backend"}"""
        socket.outputStream.write("HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n$body".toByteArray(Charsets.US_ASCII))
        socket.outputStream.flush()
      }
    }
    try {
      val connection = MobileTlsConnection({ identity }, { MobileTlsKeyManager(key, cert) { true } }) { _, port, timeout ->
        Socket().apply { connect(InetSocketAddress("127.0.0.1", port), timeout) }
      }
      assertTrue(MobileHealthProbe.check(connection))
    } finally { server.close(); worker.join(6000) }
  }

  @Test fun connectsToThePairedDesktopWithMutualTlsAndRejectsRevocation() {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileTlsConnectionTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val serverContext = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
    var identity: DesktopIdentity? = null
    val manager = MobileTlsKeyManager(key, cert) { identity != null }
    fun attempt(revoke: Boolean): Boolean {
      val server = (serverContext.serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
      identity = DesktopIdentity("192.168.1.20", server.localPort, MobileIdentityRules.certificatePem(cert.encoded)!!, fingerprint)
      val worker = thread {
        try { (server.accept() as SSLSocket).use { it.soTimeout = 5000; it.startHandshake(); it.outputStream.write(7); it.outputStream.flush() } }
        catch (_: Exception) { }
      }
      return try {
        val connection = MobileTlsConnection({ identity }, { manager }) { _, port, timeout ->
          Socket().apply { connect(InetSocketAddress("127.0.0.1", port), timeout) }
        }
        connection.use { socket ->
          assertEquals(7, socket.inputStream.read())
          if (revoke) identity = null
          true
        }
      } catch (_: java.io.IOException) { false }
      finally { server.close(); worker.join(6000) }
    }
    assertTrue(attempt(false))
    assertFalse(attempt(true))
  }
}
