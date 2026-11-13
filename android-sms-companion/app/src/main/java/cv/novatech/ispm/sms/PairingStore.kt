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
class PairingStore(context: Context) {
  private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)
  // Read on every signed request: decrypt once, not per request.
  @Volatile private var cached: String? = null

  fun save(secret: String, deviceName: String, version: Int = 1) {
    prefs.edit()
      .remove("secret")
      .putString("sealed", seal(secret))
      .putString("deviceName", deviceName)
      .putInt("version", version)
      .apply()
    cached = secret
  }

  fun secret(): String {
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
  fun version(): Int = prefs.getInt("version", 1)
  fun isPaired(): Boolean = secret().isNotBlank()

  fun clear() {
    prefs.edit().clear().apply()
    cached = ""
  }

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
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
