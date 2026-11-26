package cv.novatech.ispm.sms

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persists the HMAC secret shared with the desktop. On disk it is AES-GCM
 * sealed by a non-exportable Android Keystore key (0.11+, ADR 0023); 0.10 and
 * older wrote it in clear, and the first read moves it into the seal. A seal
 * that no longer opens (key gone) reads as "not paired": re-pair, never guess.
 */
class PairingStore(context: Context) : CompanionPairing {
  private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)
  // Read on every signed request: decrypt once, not per request.
  @Volatile private var cached: String? = null
  private val desktopRegistry = DesktopIdentityRegistry(object : DesktopIdentityRepository {
    override fun read(): String? = prefs.getString(DESKTOP_IDENTITY, null)?.let { open(it) }
    override fun write(record: String): Boolean = prefs.edit().putString(DESKTOP_IDENTITY, seal(record)).commit()
  }) { DesktopPairing(version(), secret()) }

  @Synchronized fun save(secret: String, deviceName: String, version: Int = 1) {
    val previous = cached ?: prefs.getString("secret", null)
      ?: prefs.getString("sealed", null)?.let { runCatching { open(it) }.getOrNull() }
    val oldVersion = version()
    val edit = prefs.edit()
      .remove("secret")
      // Outro pareamento, outra caixa no relé: o PC volta a dizer onde fica.
      .remove("relayUrl")
      .putString("sealed", seal(secret))
      .putString("deviceName", deviceName)
      .putInt("version", version)
    if (previous != secret || oldVersion != version) edit.remove(DESKTOP_IDENTITY)
    edit.apply()
    cached = secret
    if (!previous.isNullOrBlank() && previous != secret) MobileDeviceIdentity.forget(previous)
  }

  @Synchronized override fun secret(): String {
    cached?.let { return it }
    val legacy = prefs.getString("secret", null)
    if (!legacy.isNullOrBlank()) {
      // Keystore refused: keep working with the clear copy and retry next start.
      runCatching { save(legacy, deviceName(), version()) }
      return legacy
    }
    val opened = prefs.getString("sealed", null)?.let { runCatching { open(it) }.getOrNull() } ?: ""
    cached = opened
    return opened
  }

  fun deviceName(): String = prefs.getString("deviceName", "") ?: ""
  @Synchronized override fun version(): Int = prefs.getInt("version", 1)
  fun isPaired(): Boolean = secret().isNotBlank()

  /** Where the relay lives (ADR 0024); blank until the paired PC says so. */
  fun relayUrl(): String = prefs.getString("relayUrl", "") ?: ""
  override fun saveRelayUrl(url: String) = prefs.edit().putString("relayUrl", url).apply()

  @Synchronized fun clear() {
    val previous = secret()
    prefs.edit().clear().apply()
    cached = ""
    MobileDeviceIdentity.forget(previous)
  }

  @Synchronized override fun registerDesktopIdentity(expectedSecret: String, host: String, port: Int, pem: String): DesktopIdentityResult =
    desktopRegistry.register(expectedSecret, host, port, pem)

  @Synchronized fun desktopIdentity(): DesktopIdentity? = desktopRegistry.current()

  fun desktopTlsTrust(): DesktopTlsTrust = DesktopTlsTrust.fromRegistry { desktopIdentity() }

  @Synchronized fun mobileTlsKeyManager(): MobileTlsKeyManager? {
    val pairedSecret = secret()
    if (version() != 2 || desktopRegistry.current() == null) return null
    return MobileDeviceIdentity.tlsKeyManager(pairedSecret) {
      synchronized(this) { version() == 2 && secret() == pairedSecret && desktopRegistry.current() != null }
    }
  }

  internal fun mobileTlsConnection(): MobileTlsConnection =
    MobileTlsConnection({ desktopIdentity() }, { mobileTlsKeyManager() })

  internal fun mobileHttpClient(): MobileHttpClient =
    MobileHttpClient({ desktopIdentity() }, { mobileTlsKeyManager() })

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build()
      )
    }.generateKey()
  }

  private fun seal(plain: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
    return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }

  private fun open(sealed: String): String {
    val bytes = Base64.decode(sealed, Base64.NO_WRAP)
    val cipher = Cipher.getInstance(TRANSFORMATION).apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
    }
    return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
  }

  private companion object {
    const val ALIAS = "ispm-pairing"
    const val DESKTOP_IDENTITY = "mobileDesktopIdentity"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
