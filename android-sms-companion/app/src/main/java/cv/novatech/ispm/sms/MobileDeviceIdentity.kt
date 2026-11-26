package cv.novatech.ispm.sms

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal

/** Private keys stay in Android Keystore and are scoped to the current v2 pairing. */
object MobileDeviceIdentity {
  private const val PROVIDER = "AndroidKeyStore"
  private const val CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2"
  private const val DAY_MS = 24L * 60 * 60 * 1000
  private val manager = MobileIdentityManager(AndroidBackend())

  fun certificatePem(secret: String): String? = manager.certificatePem(secret)
  fun forget(secret: String) = manager.forget(secret)

  /** Uses an already enrolled key; it never generates or exports one. */
  fun tlsKeyManager(secret: String, isCurrent: () -> Boolean): MobileTlsKeyManager? = runCatching {
    val alias = MobileIdentityRules.aliasFor(secret) ?: return null
    val backend = AndroidBackend()
    backend.read(alias) ?: return null
    val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
    val key = store.getKey(alias, null) as? PrivateKey ?: return null
    val certificate = store.getCertificate(alias) as? X509Certificate ?: return null
    if (!isCurrent()) return null
    MobileTlsKeyManager(key, certificate, isCurrent)
  }.getOrNull()

  private class AndroidBackend : MobileIdentityBackend {
    private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    override fun read(alias: String): ByteArray? {
      val store = store()
      if (!store.containsAlias(alias)) return null
      return checkedCertificate(store, alias)
    }

    override fun create(alias: String): ByteArray {
      val store = store()
      check(!store.containsAlias(alias))
      val now = System.currentTimeMillis()
      val serial = BigInteger(128, SecureRandom()).add(BigInteger.ONE)
      val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
        .setUserAuthenticationRequired(false)
        .setCertificateSubject(X500Principal("CN=ISPM mobile client"))
        .setCertificateSerialNumber(serial)
        .setCertificateNotBefore(Date(now - DAY_MS))
        .setCertificateNotAfter(Date(now + 5L * 365 * DAY_MS))
        .build()
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec) }.generateKeyPair()
      return checkedCertificate(store(), alias)
    }

    override fun delete(alias: String) { store().deleteEntry(alias) }

    private fun checkedCertificate(store: KeyStore, alias: String): ByteArray {
      val cert = store.getCertificate(alias) as? X509Certificate ?: error("MOBILE_IDENTITY_MISSING")
      val privateKey = store.getKey(alias, null) as? PrivateKey ?: error("MOBILE_IDENTITY_MISSING")
      val publicKey = cert.publicKey as? ECPublicKey ?: error("MOBILE_IDENTITY_INVALID")
      check(publicKey.params.curve.field.fieldSize == 256)
      check(cert.basicConstraints == -1)
      check(cert.extendedKeyUsage?.contains(CLIENT_AUTH_OID) != false)
      check(cert.keyUsage?.getOrNull(0) != false)
      cert.checkValidity()
      cert.verify(publicKey)
      // Prove that the non-exportable private key still matches the stored certificate.
      val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
      val signed = Signature.getInstance("SHA256withECDSA").run {
        initSign(privateKey); update(challenge); sign()
      }
      check(Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey); update(challenge); verify(signed) })
      return cert.encoded
    }
  }
}
