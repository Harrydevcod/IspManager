package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.security.auth.x500.X500Principal
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread

class MobileTlsKeyManagerTest {
  @Test fun selectsOnlyTheCurrentCompatibleClientIdentity() {
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileTlsKeyManagerTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, "test-only".toCharArray()) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", "test-only".toCharArray()) as PrivateKey
    var active = true
    val manager = MobileTlsKeyManager(key, cert) { active }
    val selected = manager.chooseClientAlias(arrayOf("RSA", "EC"), arrayOf(cert.issuerX500Principal), null)
    assertNotNull(selected)
    assertEquals(key, manager.getPrivateKey(selected))
    assertArrayEquals(arrayOf(cert), manager.getCertificateChain(selected))
    assertNull(manager.chooseClientAlias(arrayOf("RSA"), null, null))
    assertNull(manager.chooseClientAlias(arrayOf("EC"), arrayOf(X500Principal("CN=other")), null))
    assertNull(manager.getPrivateKey("other"))
    active = false
    assertNull(manager.chooseClientAlias(arrayOf("EC"), null, null))
    assertNull(manager.getPrivateKey(selected))
    assertNull(manager.getCertificateChain(selected))
  }

  @Test fun presentsTheClientIdentityInMutualTls() {
    val password = "test-only".toCharArray()
    val store = KeyStore.getInstance("PKCS12").apply {
      requireNotNull(MobileTlsKeyManagerTest::class.java.getResourceAsStream("/mobile-identity/test-desktop.p12")).use { load(it, password) }
    }
    val cert = store.getCertificate("test-desktop") as X509Certificate
    val key = store.getKey("test-desktop", password) as PrivateKey
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
    val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("client", cert) }
    val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
    val serverContext = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, trust.trustManagers, null) }
    fun connect(active: Boolean): Boolean {
      val server = (serverContext.serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply { needClientAuth = true; soTimeout = 5000 }
      val worker = thread {
        try { (server.accept() as SSLSocket).use { it.soTimeout = 5000; it.startHandshake(); it.outputStream.write(7); it.outputStream.flush() } }
        catch (_: Exception) { }
      }
      return try {
        val manager = MobileTlsKeyManager(key, cert) { active }
        val client = SSLContext.getInstance("TLS").apply { init(arrayOf(manager), arrayOf(DesktopTlsTrust { cert }), null) }
        (client.socketFactory.createSocket("127.0.0.1", server.localPort) as SSLSocket).use { it.soTimeout = 5000; it.startHandshake(); it.inputStream.read() == 7 }
      } catch (_: java.io.IOException) { false }
      finally { server.close(); worker.join(6000) }
    }
    assertTrue(connect(true))
    assertFalse(connect(false))
  }
}
