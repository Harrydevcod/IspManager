package cv.novatech.ispm.sms.state

import java.net.URLDecoder

data class PairingInfo(val secret: String, val deviceName: String)

fun parsePairingPayload(raw: String): PairingInfo? {
  val trimmed = raw.trim()
  if (!trimmed.startsWith("ispm-sms://pair")) return null
  val query = trimmed.substringAfter('?', "")
  val params = query.split('&').mapNotNull { part ->
    val i = part.indexOf('=')
    if (i <= 0) null else
      URLDecoder.decode(part.substring(0, i), "UTF-8") to URLDecoder.decode(part.substring(i + 1), "UTF-8")
  }.toMap()
  val secret = params["secret"]?.takeIf { it.isNotBlank() } ?: return null
  val device = params["device"]?.takeIf { it.isNotBlank() } ?: "ISPM Desktop"
  return PairingInfo(secret, device)
}
