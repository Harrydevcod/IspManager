package cv.novatech.ispm.sms

import org.json.JSONObject
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class DesktopPairing(val version: Int, val secret: String)
enum class DesktopIdentityResult { SAVED, INVALID, CONFLICT, UNAVAILABLE, PAIRING_CHANGED }

/** Reads and writes an OS-protected record; an unreadable existing record must throw. */
interface DesktopIdentityRepository {
  fun read(): String?
  fun write(record: String): Boolean
}

class DesktopIdentityRegistry(private val repository: DesktopIdentityRepository, private val pairing: () -> DesktopPairing) {
  private fun currentPairing(): DesktopPairing? {
    val value = pairing()
    return value.takeIf { it.version == 2 && it.secret.matches(Regex("[0-9a-fA-F]{64}")) }
  }

  private fun binding(secret: String, identity: DesktopIdentity): ByteArray {
    val key = ByteArray(32) { i -> secret.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    val data = "ispm-mobile-desktop-v1\n${identity.fingerprintSha256}\n${identity.host}\n${identity.port}"
    return mac.doFinal(data.toByteArray(Charsets.UTF_8))
  }

  private fun encode(secret: String, identity: DesktopIdentity): String = JSONObject()
    .put("version", 1).put("host", identity.host).put("port", identity.port)
    .put("certificatePem", identity.certificatePem)
    .put("binding", binding(secret, identity).joinToString("") { "%02x".format(it) }).toString()

  private fun decode(secret: String, record: String): DesktopIdentity? = runCatching {
    val json = JSONObject(record)
    require(json.getInt("version") == 1)
    val identity = DesktopIdentityRules.validate(json.getString("host"), json.getInt("port"), json.getString("certificatePem")) ?: return null
    val encoded = json.getString("binding")
    require(encoded.matches(Regex("[0-9a-f]{64}")))
    val stored = ByteArray(32) { i -> encoded.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    if (!MessageDigest.isEqual(binding(secret, identity), stored)) return null
    identity
  }.getOrNull()

  @Synchronized fun current(): DesktopIdentity? = runCatching {
    val active = currentPairing() ?: return null
    val record = repository.read() ?: return null
    decode(active.secret, record)
  }.getOrNull()

  /** The caller serializes this operation with changes to the pairing itself. */
  @Synchronized fun register(expectedSecret: String, host: String, port: Int, certificatePem: String): DesktopIdentityResult {
    val active = currentPairing() ?: return DesktopIdentityResult.PAIRING_CHANGED
    if (!active.secret.equals(expectedSecret, ignoreCase = true)) return DesktopIdentityResult.PAIRING_CHANGED
    val identity = DesktopIdentityRules.validate(host, port, certificatePem) ?: return DesktopIdentityResult.INVALID
    val existing = try { repository.read() } catch (_: Exception) { return DesktopIdentityResult.UNAVAILABLE }
    if (existing != null) {
      val trusted = decode(active.secret, existing) ?: return DesktopIdentityResult.CONFLICT
      if (trusted.fingerprintSha256 != identity.fingerprintSha256) return DesktopIdentityResult.CONFLICT
    }
    val latest = currentPairing()
    if (latest == null || !latest.secret.equals(active.secret, ignoreCase = true)) return DesktopIdentityResult.PAIRING_CHANGED
    return try {
      if (repository.write(encode(active.secret, identity))) DesktopIdentityResult.SAVED else DesktopIdentityResult.UNAVAILABLE
    } catch (_: Exception) { DesktopIdentityResult.UNAVAILABLE }
  }
}
