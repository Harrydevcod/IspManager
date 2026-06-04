package cv.novatech.ispm.sms

import android.content.Context

/**
 * Persists the shared HMAC secret negotiated during desktop pairing. The secret
 * never leaves the device after pairing; every inbound desktop request is
 * verified against it.
 */
class PairingStore(context: Context) {
  private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)

  fun save(secret: String, deviceName: String) {
    prefs.edit().putString("secret", secret).putString("deviceName", deviceName).apply()
  }

  fun secret(): String = prefs.getString("secret", "") ?: ""
  fun deviceName(): String = prefs.getString("deviceName", "") ?: ""
  fun isPaired(): Boolean = secret().isNotBlank()
  fun clear() = prefs.edit().clear().apply()
}
