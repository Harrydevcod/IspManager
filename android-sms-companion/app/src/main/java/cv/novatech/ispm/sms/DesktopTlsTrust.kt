package cv.novatech.ispm.sms

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.cert.CertificateFactory
import javax.net.ssl.X509TrustManager

/** Trust only the exact desktop certificate associated with the current pairing. */
class DesktopTlsTrust(private val currentCertificate: () -> X509Certificate?) : X509TrustManager {
  companion object {
    /** Resolve the registry on each handshake so forgotten or changed pairings fail closed. */
    fun fromRegistry(current: () -> DesktopIdentity?): DesktopTlsTrust = DesktopTlsTrust {
      val identity = current() ?: return@DesktopTlsTrust null
      val valid = DesktopIdentityRules.validate(identity.host, identity.port, identity.certificatePem) ?: return@DesktopTlsTrust null
      if (identity.fingerprintSha256 != valid.fingerprintSha256) return@DesktopTlsTrust null
      CertificateFactory.getInstance("X.509").generateCertificate(valid.certificatePem.byteInputStream(Charsets.US_ASCII)) as? X509Certificate
    }
  }
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("Client certificates are not trusted here")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    try {
      if (chain == null || chain.size != 1 || authType.isNullOrBlank()) throw CertificateException("Invalid server certificate chain")
      val trusted = currentCertificate() ?: throw CertificateException("Desktop is not paired")
      val presented = chain[0]
      trusted.checkValidity()
      presented.checkValidity()
      if (!MessageDigest.isEqual(trusted.encoded, presented.encoded)) throw CertificateException("Unrecognised desktop")
    } catch (error: CertificateException) {
      throw error
    } catch (error: Exception) {
      throw CertificateException("Desktop identity unavailable", error)
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
