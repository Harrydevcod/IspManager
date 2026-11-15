package cv.novatech.ispm.sms

import cv.novatech.ispm.sms.pairing.PairingHandshake
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class RelayEnvelope(val version: Int, val expiresAt: Long, val nonce: String, val ciphertext: String, val tag: String)

/**
 * Relé cifrado (ADR 0024), o lado do telemóvel. Tem de dar exatamente o mesmo
 * que src/backend/lib/sms-relay-crypto.ts: o vetor partilhado vive nos dois testes.
 */
object RelayCrypto {
  class Keys(val mailbox: ByteArray, val desktop: ByteArray, val phone: ByteArray, val request: ByteArray, val response: ByteArray)

  private const val DOMAIN = "ispm-sms-relay/v1"
  private const val MAX_BYTES = 2 * 1024 * 1024
  private const val MAX_LIFETIME_MS = 6 * 60_000L
  private val SECRET = Regex("^[0-9a-fA-F]{64}$")
  private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

  /** Só o pareamento v2 guarda 32 bytes em hexadecimal; cada fim tem a sua chave. */
  fun deriveKeys(secret: String): Keys {
    require(SECRET.matches(secret)) { "Pareamento v2 invalido" }
    val ikm = secret.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    fun derive(purpose: String) = PairingHandshake.hkdf(ikm, DOMAIN.toByteArray(Charsets.UTF_8), "$DOMAIN/$purpose", 32)
    return Keys(derive("mailbox"), derive("desktop-access"), derive("phone-access"), derive("request-key"), derive("response-key"))
  }

  fun seal(secret: String, direction: String, id: String, expiresAt: Long, plaintext: ByteArray): RelayEnvelope {
    require(plaintext.size <= MAX_BYTES) { "Mensagem demasiado grande" }
    val keys = deriveKeys(secret)
    val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val sealed = cipher(Cipher.ENCRYPT_MODE, keys, direction, id, expiresAt, nonce).doFinal(plaintext)
    val cut = sealed.size - 16
    return RelayEnvelope(1, expiresAt, b64(nonce), b64(sealed.copyOfRange(0, cut)), b64(sealed.copyOfRange(cut, sealed.size)))
  }

  /** Lança se o envelope expirou, foi alterado ou pertence a outra troca ou direção. */
  fun open(secret: String, direction: String, id: String, envelope: RelayEnvelope, now: Long = System.currentTimeMillis()): ByteArray {
    require(envelope.version == 1 && envelope.expiresAt > now && envelope.expiresAt <= now + MAX_LIFETIME_MS) { "Envelope expirado ou invalido" }
    val nonce = decode(envelope.nonce, 12)
    val tag = decode(envelope.tag, 16)
    require(nonce.size == 12 && tag.size == 16) { "Envelope invalido" }
    val ciphertext = decode(envelope.ciphertext, MAX_BYTES)
    return cipher(Cipher.DECRYPT_MODE, deriveKeys(secret), direction, id, envelope.expiresAt, nonce).doFinal(ciphertext + tag)
  }

  private fun cipher(mode: Int, keys: Keys, direction: String, id: String, expiresAt: Long, nonce: ByteArray): Cipher {
    val key = when (direction) {
      "request" -> keys.request
      "response" -> keys.response
      else -> throw IllegalArgumentException("Envelope invalido")
    }
    require(UUID.matches(id) && expiresAt > 0) { "Envelope invalido" }
    val aad = "$DOMAIN\n${keys.mailbox.toHex()}\n$direction\n$id\n$expiresAt".toByteArray(Charsets.UTF_8)
    return Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
      updateAAD(aad)
    }
  }

  private fun b64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  private fun decode(value: String, maxBytes: Int): ByteArray {
    require(value.length <= (maxBytes * 4 + 2) / 3) { "Envelope invalido" }
    val decoded = Base64.getUrlDecoder().decode(value)
    require(b64(decoded) == value) { "Envelope invalido" }
    return decoded
  }
}

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
