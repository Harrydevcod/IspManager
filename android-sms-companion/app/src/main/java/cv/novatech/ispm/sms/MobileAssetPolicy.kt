package cv.novatech.ispm.sms

import java.net.URI

/** Only packaged ERP assets may be navigated to or loaded by the WebView. */
internal object MobileAssetPolicy {
  fun allows(value: String): Boolean = try {
    val uri = URI(value)
    val path = uri.rawPath ?: ""
    uri.scheme == "https" && uri.rawAuthority == "appassets.androidplatform.net" &&
      path.startsWith("/assets/ispm/") && '%' !in path && '\\' !in path &&
      path.split('/').none { it == "." || it == ".." }
  } catch (_: Exception) { false }
}
