package cv.novatech.ispm.sms

import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/** Exposes only one non-exportable client key while its pairing remains active. */
class MobileTlsKeyManager(
  private val privateKey: PrivateKey,
  private val certificate: X509Certificate,
  private val isCurrent: () -> Boolean
) : X509ExtendedKeyManager() {
  private val alias = "ispm-mobile-client"

  private fun usable(): Boolean = runCatching {
    certificate.checkValidity()
    isCurrent()
  }.getOrDefault(false)

  override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? {
    if (!usable() || !keyType.equals("EC", ignoreCase = true)) return null
    if (!issuers.isNullOrEmpty() && issuers.none { it == certificate.issuerX500Principal }) return null
    return arrayOf(alias)
  }

  override fun chooseClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? =
    keyTypes?.firstNotNullOfOrNull { getClientAliases(it, issuers)?.firstOrNull() }

  override fun chooseEngineClientAlias(keyTypes: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String? =
    chooseClientAlias(keyTypes, issuers, null)

  override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
    if (alias == this.alias && usable()) arrayOf(certificate) else null

  override fun getPrivateKey(alias: String?): PrivateKey? =
    if (alias == this.alias && usable()) privateKey else null

  override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
  override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
}
