package cv.novatech.ispm.sms

import java.security.MessageDigest
import java.util.Base64

/** Device identity is scoped to one v2 pairing and never exposes its secret in the alias. */
object MobileIdentityRules {
  private val secretPattern = Regex("^[0-9a-fA-F]{64}$")
  private const val MAX_CERT_BYTES = 8192
  const val CERTIFICATE_PATH = "/mobile/device-certificate"
  const val DESKTOP_IDENTITY_PATH = "/mobile/desktop-identity"

  fun allowProof(lan: Boolean, method: String, path: String, pairingVersion: Int): Boolean =
    lan && method == "GET" && path == CERTIFICATE_PATH && pairingVersion == 2

  fun allowDesktopIdentity(lan: Boolean, method: String, path: String, pairingVersion: Int): Boolean =
    lan && method == "POST" && path == DESKTOP_IDENTITY_PATH && pairingVersion == 2

  fun aliasFor(secret: String): String? {
    if (!secretPattern.matches(secret)) return null
    val bytes = ByteArray(32) { i -> secret.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return "ispm-mobile-v1-$digest"
  }

  fun certificatePem(der: ByteArray): String? {
    if (der.isEmpty() || der.size > MAX_CERT_BYTES) return null
    val encoded = Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(der)
    return "-----BEGIN CERTIFICATE-----\n$encoded\n-----END CERTIFICATE-----\n"
  }
}
