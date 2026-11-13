package cv.novatech.ispm.sms.pairing

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Pareamento v2 (ADR 0023), o lado do telemóvel. Tem de dar exatamente o mesmo
 * que src/backend/lib/sms-pairing.ts: o vetor partilhado vive nos dois testes.
 * P-256 porque existe desde a API 26 (minSdk); X25519 só a partir da 31/33.
 */
object PairingHandshake {
  data class Keys(val secret: String, val sas: String)

  fun generateKeyPair(): KeyPair =
    KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

  /** 0x04 ‖ x ‖ y, como o `ECDH.getPublicKey()` do Node. */
  fun encode(pub: PublicKey): ByteArray {
    val w = (pub as ECPublicKey).w
    return byteArrayOf(4) + fixed32(w.affineX) + fixed32(w.affineY)
  }

  fun decode(bytes: ByteArray): PublicKey {
    require(bytes.size == 65 && bytes[0] == 4.toByte()) { "chave pública inválida" }
    val point = ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params()))
  }

  /** A coordenada x do ponto partilhado (32 bytes), igual ao `computeSecret` do Node. */
  fun sharedSecret(own: PrivateKey, peer: PublicKey): ByteArray =
    KeyAgreement.getInstance("ECDH").apply { init(own); doPhase(peer, true) }.generateSecret()

  fun derive(shared: ByteArray, token: ByteArray): Keys {
    val secret = hex(hkdf(shared, token, "ispm-pair-v2/hmac", 32))
    val sasBytes = hkdf(shared, token, "ispm-pair-v2/sas", 4)
    val n = BigInteger(1, sasBytes).mod(BigInteger.valueOf(1_000_000)).toInt()
    return Keys(secret, n.toString().padStart(6, '0'))
  }

  /** A prova de que este telemóvel leu ESTE QR: só quem tem S a calcula. */
  fun offerMac(secret: String, desktopPub: ByteArray, phonePub: ByteArray): String =
    hex(hmac(secret.toByteArray(Charsets.UTF_8), "offer\n${b64url(desktopPub)}\n${b64url(phonePub)}".toByteArray(Charsets.UTF_8)))

  fun tokenHash(token: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(token)).take(32)

  fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
  fun fromB64url(text: String): ByteArray = Base64.getUrlDecoder().decode(text)

  /** RFC 5869, só com o que este protocolo usa (um ou dois blocos). */
  internal fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray {
    val prk = hmac(salt, ikm)
    var block = ByteArray(0)
    val out = java.io.ByteArrayOutputStream()
    var counter = 1
    while (out.size() < length) {
      block = hmac(prk, block + info.toByteArray(Charsets.UTF_8) + byteArrayOf(counter++.toByte()))
      out.write(block)
    }
    return out.toByteArray().copyOf(length)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun fixed32(n: BigInteger): ByteArray {
    val raw = n.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    return ByteArray(32 - raw.size) + raw
  }

  internal fun params(): ECParameterSpec = (generateKeyPair().public as ECPublicKey).params
}
