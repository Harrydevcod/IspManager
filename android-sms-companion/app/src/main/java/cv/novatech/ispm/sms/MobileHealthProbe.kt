package cv.novatech.ispm.sms

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

/** A bounded health check; it does not send credentials or follow redirects. */
internal object MobileHealthProbe {
  fun check(connection: MobileTlsConnection): Boolean = connection.use { socket ->
    val request = "GET /health HTTP/1.1\r\nHost: ispm.local\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    socket.outputStream.write(request.toByteArray(Charsets.US_ASCII))
    socket.outputStream.flush()
    readResponse(socket.inputStream)
  }

  internal fun readResponse(input: InputStream): Boolean {
    val header = ByteArrayOutputStream()
    var matched = 0
    val end = byteArrayOf(13, 10, 13, 10)
    while (matched < end.size) {
      val value = input.read()
      if (value < 0 || header.size() >= 8192) throw IOException("Invalid response headers")
      header.write(value)
      matched = if (value == end[matched].toInt()) matched + 1 else if (value == 13) 1 else 0
    }
    val lines = header.toString("US-ASCII").split("\r\n")
    if (!lines.first().matches(Regex("HTTP/1\\.[01] 200(?: .*)?"))) throw IOException("Backend unavailable")
    var length: Int? = null
    for (line in lines.drop(1).filter { it.isNotEmpty() }) {
      val separator = line.indexOf(':')
      if (separator <= 0 || line.first().isWhitespace()) throw IOException("Invalid response header")
      val name = line.substring(0, separator).lowercase(Locale.ROOT)
      val value = line.substring(separator + 1).trim()
      if (name == "transfer-encoding") throw IOException("Unsupported response encoding")
      if (name == "content-length") {
        if (length != null || !value.matches(Regex("[0-9]{1,4}"))) throw IOException("Invalid response length")
        length = value.toInt()
      }
    }
    val size = length?.takeIf { it in 1..4096 } ?: throw IOException("Invalid response length")
    val bytes = ByteArray(size)
    var offset = 0
    while (offset < size) {
      val read = input.read(bytes, offset, size - offset)
      if (read <= 0) throw IOException("Truncated response")
      offset += read
    }
    val body = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (error: Exception) { throw IOException("Invalid health response", error) }
    if (body.opt("ok") != true || body.opt("service") != "ispm-backend") throw IOException("Backend unavailable")
    return true
  }
}
