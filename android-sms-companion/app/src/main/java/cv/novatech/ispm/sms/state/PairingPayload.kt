package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.pairing.PairingHandshake
import java.net.URLDecoder

sealed interface PairingInfo {
  val deviceName: String

  /** ISPM até à 2.66: o segredo vinha no próprio QR. */
  data class V1(val secret: String, override val deviceName: String) : PairingInfo

  /** ADR 0023: só a chave pública do PC e um token de uso único. */
  class V2(val desktopPub: ByteArray, val token: ByteArray, override val deviceName: String) : PairingInfo
}

fun parsePairingPayload(raw: String): PairingInfo? {
  val trimmed = raw.trim()
  if (!trimmed.startsWith("ispm-sms://pair")) return null
  val query = trimmed.substringAfter('?', "")
  val params = query.split('&').mapNotNull { part ->
    val i = part.indexOf('=')
    if (i <= 0) null else
      URLDecoder.decode(part.substring(0, i), "UTF-8") to URLDecoder.decode(part.substring(i + 1), "UTF-8")
  }.toMap()
  if (params["v"] == "2") {
    val name = params["n"]?.takeIf { it.isNotBlank() } ?: "ISPM Desktop"
    return runCatching {
      val pub = PairingHandshake.fromB64url(params.getValue("k"))
      val token = PairingHandshake.fromB64url(params.getValue("t"))
      PairingHandshake.decode(pub)
      if (token.size != 16) return null
      PairingInfo.V2(pub, token, name)
    }.getOrNull()
  }
  val secret = params["secret"]?.takeIf { it.isNotBlank() } ?: return null
  val device = params["device"]?.takeIf { it.isNotBlank() } ?: "ISPM Desktop"
  return PairingInfo.V1(secret, device)
}
