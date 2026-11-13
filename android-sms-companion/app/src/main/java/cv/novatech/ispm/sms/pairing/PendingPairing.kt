package cv.novatech.ispm.sms.pairing

import cv.novatech.ispm.sms.state.PairingInfo
import org.json.JSONObject

/**
 * O QR v2 lido e ainda não confirmado no PC. Só em memória e por 2 minutos: o
 * segredo derivado só é gravado quando o PC o prova num `POST /pair/confirm`.
 * A chave privada efémera morre aqui, logo depois do ECDH.
 */
class PendingPairing(
  val desktopPub: ByteArray,
  val desktopName: String,
  val phonePub: ByteArray,
  val secret: String,
  val sas: String,
  val tokenHash: String,
  val expiresAt: Long
) {
  fun live(now: Long) = now < expiresAt

  fun offer(model: String): JSONObject = JSONObject()
    .put("pub", PairingHandshake.b64url(phonePub))
    .put("mac", PairingHandshake.offerMac(secret, desktopPub, phonePub))
    .put("model", model)

  companion object {
    const val TTL_MS = 120_000L

    fun start(info: PairingInfo.V2, now: Long): PendingPairing {
      val own = PairingHandshake.generateKeyPair()
      val shared = PairingHandshake.sharedSecret(own.private, PairingHandshake.decode(info.desktopPub))
      val keys = PairingHandshake.derive(shared, info.token)
      return PendingPairing(
        desktopPub = info.desktopPub,
        desktopName = info.deviceName,
        phonePub = PairingHandshake.encode(own.public),
        secret = keys.secret,
        sas = keys.sas,
        tokenHash = PairingHandshake.tokenHash(info.token),
        expiresAt = now + TTL_MS
      )
    }
  }
}
