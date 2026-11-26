package cv.novatech.ispm.sms

import org.json.JSONObject
import java.util.Base64
import java.util.Locale

/** Validates the protocol independently of the WebView listener and transport. */
internal class MobileBridgeHandler(private val execute: (String, String, Map<String, String>, ByteArray?) -> MobileHttpResponse) {
  fun handle(origin: String, isMainFrame: Boolean, message: String): String? {
    if (!isMainFrame || origin != ORIGIN || message.length > MAX_ENCODED + 8192) return null
    val request = try { JSONObject(message) } catch (_: Exception) { return null }
    val id = request.opt("id") as? String ?: return null
    if (!id.matches(Regex("[1-9][0-9]{0,15}"))) return null
    fun error(): String = JSONObject().put("id", id).put("error", true).toString()
    return try {
      require(request.keys().asSequence().toSet() == setOf("id", "method", "path", "headers", "body"))
      val method = request.get("method") as? String ?: return error()
      val path = request.get("path") as? String ?: return error()
      val encoded = request.get("body") as? String ?: return error()
      require(method in setOf("GET", "POST", "PUT", "PATCH", "DELETE"))
      require(path.length <= 8192 && (path.startsWith("/api/") || path == "/health" && method == "GET"))
      require(encoded.length <= MAX_ENCODED)
      val bytes = Base64.getDecoder().decode(encoded)
      require(bytes.size <= MAX_BYTES && (method != "GET" || bytes.isEmpty()))
      val rawHeaders = request.getJSONObject("headers")
      require(rawHeaders.length() <= REQUEST_HEADERS.size)
      val headers = mutableMapOf<String, String>()
      for (name in rawHeaders.keys().asSequence()) {
        val normalized = name.lowercase(Locale.ROOT)
        require(normalized in REQUEST_HEADERS && !headers.containsKey(normalized))
        val value = rawHeaders.get(name) as? String ?: return error()
        require(value.length <= 8192 && value.none { it == '\r' || it == '\n' })
        headers[normalized] = value
      }
      val response = execute(method, path, headers, if (method == "GET") null else bytes)
      require(response.status in 200..599 && response.status !in 300..399 && response.body.size <= MAX_BYTES)
      val responseHeaders = JSONObject()
      response.headers.forEach { (name, value) ->
        if (name.lowercase(Locale.ROOT) in RESPONSE_HEADERS && value.length <= 8192 && value.none { it == '\r' || it == '\n' }) responseHeaders.put(name, value)
      }
      JSONObject().put("id", id).put("status", response.status).put("headers", responseHeaders)
        .put("body", Base64.getEncoder().encodeToString(response.body)).toString()
    } catch (_: Exception) { error() }
  }

  companion object {
    const val ORIGIN = "https://appassets.androidplatform.net"
    private const val MAX_BYTES = 16 * 1024 * 1024
    private const val MAX_ENCODED = ((MAX_BYTES + 2) / 3) * 4
    private val REQUEST_HEADERS = setOf("accept", "authorization", "content-type", "if-match", "if-none-match", "range")
    private val RESPONSE_HEADERS = setOf("content-type", "content-disposition", "content-length", "etag", "last-modified", "retry-after", "content-range", "accept-ranges")
  }
}
