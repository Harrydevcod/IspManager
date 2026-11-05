package cv.novatech.ispm.sms.dashboard

import org.json.JSONObject
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The Painel snapshot arrives AES-256-GCM sealed with a key derived from the
 * pairing secret (desktop: src/backend/lib/companion-crypto.ts), because the LAN
 * transport is plain HTTP and the snapshot carries client phones and addresses.
 * An older desktop still sends it in the clear; that stays accepted.
 */
object SealedSnapshot {
  private const val KEY_LABEL = "ispm-dashboard-v1"

  /** The JSON to parse: opened when sealed, as-is when plain, null when it can't be opened. */
  fun open(raw: String, secret: String): String? {
    val envelope = runCatching { JSONObject(raw) }.getOrNull() ?: return null
    if (!envelope.has("enc")) return raw
    if (envelope.optString("enc") != "aes-256-gcm" || secret.isBlank()) return null
    return runCatching {
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
      val key = SecretKeySpec(mac.doFinal(KEY_LABEL.toByteArray(Charsets.UTF_8)), "AES")
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(envelope.getString("iv"))))
      String(cipher.doFinal(Base64.getDecoder().decode(envelope.getString("data"))), Charsets.UTF_8)
    }.getOrNull()
  }
}
