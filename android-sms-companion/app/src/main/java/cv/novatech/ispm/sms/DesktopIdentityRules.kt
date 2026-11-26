package cv.novatech.ispm.sms

import java.io.ByteArrayInputStream
import java.security.AlgorithmParameters
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.util.Base64

data class DesktopIdentity(val host: String, val port: Int, val certificatePem: String, val fingerprintSha256: String)

object DesktopIdentityRules {
  private const val SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1"
  private const val DNS_NAME = "ispm.local"
  private val pemPattern = Regex("\\A-----BEGIN CERTIFICATE-----[\\r\\n]+([A-Za-z0-9+/=\\r\\n]+)-----END CERTIFICATE-----\\s*\\z")

  /** Only numeric unicast IPv4: never resolve a supplied name or connect to loopback. */
  private fun validHost(host: String): Boolean {
    val parts = host.split('.')
    if (parts.size != 4) return false
    val numbers = parts.map { part ->
      if (!part.matches(Regex("0|[1-9][0-9]{0,2}"))) return false
      part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
    }
    return numbers[0] in 1..223 && numbers[0] != 127
  }

  fun validate(host: String, port: Int, certificatePem: String): DesktopIdentity? {
    if (!validHost(host) || port !in 1..65535 || certificatePem.length > 16384) return null
    return runCatching {
      val match = pemPattern.matchEntire(certificatePem) ?: return null
      val der = Base64.getMimeDecoder().decode(match.groupValues[1])
      require(der.isNotEmpty() && der.size <= 8192)
      val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
      require(cert.encoded.contentEquals(der))
      cert.checkValidity()
      require(cert.basicConstraints == -1)
      require(cert.keyUsage?.getOrNull(0) != false)
      require(cert.extendedKeyUsage?.contains(SERVER_AUTH_OID) != false)
      val publicKey = cert.publicKey as? ECPublicKey ?: return null
      val p256 = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
      require(publicKey.params.curve == p256.curve && publicKey.params.generator == p256.generator && publicKey.params.order == p256.order && publicKey.params.cofactor == p256.cofactor)
      cert.verify(publicKey)
      val dnsNames = cert.subjectAlternativeNames.orEmpty().mapNotNull { entry -> if (entry.size >= 2 && entry[0] == 2) entry[1] as? String else null }
      require(dnsNames.contains(DNS_NAME))
      val fingerprint = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }
      val canonicalPem = MobileIdentityRules.certificatePem(der) ?: return null
      DesktopIdentity(host, port, canonicalPem, fingerprint)
    }.getOrNull()
  }
}
