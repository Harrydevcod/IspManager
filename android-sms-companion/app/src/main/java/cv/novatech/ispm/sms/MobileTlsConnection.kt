package cv.novatech.ispm.sms

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket

/** One operation per connection: never reuse TLS sessions after a pairing change. */
internal class MobileTlsConnection(
  private val currentIdentity: () -> DesktopIdentity?,
  private val currentKey: () -> MobileTlsKeyManager?,
  private val dial: (String, Int, Int) -> Socket = { host, port, timeout ->
    Socket().apply { try { connect(InetSocketAddress(host, port), timeout) } catch (e: Exception) { close(); throw e } }
  }
) {
  fun <T> use(operation: (SSLSocket) -> T): T {
    val identity = currentIdentity() ?: throw IOException("Desktop not paired")
    val valid = DesktopIdentityRules.validate(identity.host, identity.port, identity.certificatePem)
    if (valid != identity) throw IOException("Invalid desktop identity")
    val key = currentKey() ?: throw IOException("Client identity unavailable")
    val context = SSLContext.getInstance("TLS").apply {
      init(arrayOf(key), arrayOf(DesktopTlsTrust.fromRegistry(currentIdentity)), null)
    }
    val raw = dial(identity.host, identity.port, 5000)
    try {
      raw.soTimeout = 15000
      val tls = context.socketFactory.createSocket(raw, "ispm.local", identity.port, true) as SSLSocket
      tls.use {
        it.soTimeout = 15000
        it.enabledProtocols = it.supportedProtocols.filter { protocol -> protocol == "TLSv1.2" || protocol == "TLSv1.3" }.toTypedArray()
        it.sslParameters = it.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
        it.startHandshake()
        if (currentIdentity() != identity) throw IOException("Pairing changed")
        val result = operation(it)
        if (currentIdentity() != identity) throw IOException("Pairing changed")
        return result
      }
    } finally { raw.close() }
  }
}
