package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.KeyStore
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread

class DesktopTlsTrustTest {
  private fun cert(name: String): X509Certificate =
    requireNotNull(javaClass.getResourceAsStream("/mobile-identity/$name.pem")).use {
      CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }

  @Test fun acceptsOnlyTheCurrentlyPairedDesktop() {
    val trusted = cert("desktop-valid")
    var allowed: X509Certificate? = trusted
    val verifier = DesktopTlsTrust { allowed }
    verifier.checkServerTrusted(arrayOf(trusted), "ECDHE_ECDSA")
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(arrayOf(cert("desktop-other-valid")), "ECDHE_ECDSA") }
    allowed = null
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(arrayOf(trusted), "ECDHE_ECDSA") }
  }

  @Test fun rejectsClientTrustAndUnexpectedChains() {
    val trusted = cert("desktop-valid")
    val verifier = DesktopTlsTrust { trusted }
    assertThrows(CertificateException::class.java) { verifier.checkClientTrusted(arrayOf(trusted), "EC") }
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(emptyArray(), "EC") }
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(arrayOf(trusted, trusted), "EC") }
    assertEquals(0, verifier.acceptedIssuers.size)
  }

  @Test fun obtainsTrustFromTheCurrentPairingRegistry() {
    val pem = requireNotNull(javaClass.getResourceAsStream("/mobile-identity/desktop-valid.pem")).bufferedReader().use { it.readText() }
    var stored: String? = null
    var pairing = DesktopPairing(2, "ab".repeat(32))
    val registry = DesktopIdentityRegistry(object : DesktopIdentityRepository {
      override fun read() = stored
      override fun write(record: String): Boolean { stored = record; return true }
    }) { pairing }
    assertEquals(DesktopIdentityResult.SAVED, registry.register(pairing.secret, "192.168.1.20", 38421, pem))
    val verifier = DesktopTlsTrust.fromRegistry { registry.current() }
    verifier.checkServerTrusted(arrayOf(cert("desktop-valid")), "EC")
    pairing = DesktopPairing(2, "cd".repeat(32))
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(arrayOf(cert("desktop-valid")), "EC") }
    pairing = DesktopPairing(1, "ab".repeat(32))
    assertThrows(CertificateException::class.java) { verifier.checkServerTrusted(arrayOf(cert("desktop-valid")), "EC") }
  }

  @Test fun enforcesThePinDuringARealTlsHandshake() {
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(DesktopTlsTrustTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, "test-only".toCharArray()) }
    }
    val certificate = store.getCertificate("test-desktop") as X509Certificate
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, "test-only".toCharArray()) }
    val serverContext = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
    fun connect(expected: X509Certificate): Boolean {
      val server = serverContext.serverSocketFactory.createServerSocket(0) as SSLServerSocket
      server.soTimeout = 5000
      val worker = thread { try { (server.accept() as SSLSocket).use { it.soTimeout = 5000; it.startHandshake() } } catch (_: Exception) { } }
      return try {
        val client = SSLContext.getInstance("TLS").apply { init(null, arrayOf(DesktopTlsTrust { expected }), null) }
        (client.socketFactory.createSocket("127.0.0.1", server.localPort) as SSLSocket).use { it.soTimeout = 5000; it.startHandshake() }
        true
      } catch (_: java.io.IOException) { false }
      finally { server.close(); worker.join(6000) }
    }
    assertTrue(connect(certificate))
    assertFalse(connect(cert("desktop-other-valid")))
  }
}
