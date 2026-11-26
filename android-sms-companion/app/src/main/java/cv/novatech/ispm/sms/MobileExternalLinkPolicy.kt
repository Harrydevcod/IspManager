package cv.novatech.ispm.sms

import java.net.URI
import java.util.Locale

internal object MobileExternalLinkPolicy {
  fun allows(url: String, mainFrame: Boolean, userGesture: Boolean): Boolean = runCatching {
    if (!mainFrame || !userGesture || url.length > 8192) return false
    val parsed = URI(url)
    parsed.scheme?.lowercase(Locale.ROOT) in setOf("http", "https") &&
      !parsed.host.isNullOrBlank() && parsed.userInfo == null && parsed.port in -1..65535
  }.getOrDefault(false)
}
