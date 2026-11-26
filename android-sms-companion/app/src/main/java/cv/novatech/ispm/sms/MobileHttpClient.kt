package cv.novatech.ispm.sms

import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext

internal data class MobileHttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray)

/** A single bounded request to the desktop authenticated by the current pairing. */
internal class MobileHttpClient(
  private val currentIdentity: () -> DesktopIdentity?,
  private val currentKey: () -> MobileTlsKeyManager?,
  private val resolveAddress: (String) -> InetAddress = { InetAddress.getByName(it) }
) {
  fun execute(method: String, path: String, headers: Map<String, String>, body: ByteArray?): MobileHttpResponse {
    if (method !in setOf("GET", "POST", "PUT", "PATCH", "DELETE") ||
      !(path.startsWith("/api/") || path == "/health" && method == "GET") || path.startsWith("//") || path.any { it <= ' ' || it == '\u007f' || it == '\\' || it == '#' } ||
      body != null && body.size > MAX_BYTES || method == "GET" && body != null) throw IOException("Invalid request")
    val parsedUrl = "https://ispm.local$path".toHttpUrlOrNull() ?: throw IOException("Invalid request")
    if (parsedUrl.host != "ispm.local" || !(parsedUrl.encodedPath.startsWith("/api/") || path == "/health")) throw IOException("Invalid request")
    val allowedHeaders = setOf("accept", "authorization", "content-type", "if-match", "if-none-match", "range")
    if (headers.size > allowedHeaders.size || headers.keys.any { it.lowercase(Locale.ROOT) !in allowedHeaders } ||
      headers.keys.map { it.lowercase(Locale.ROOT) }.toSet().size != headers.size) throw IOException("Invalid request headers")
    val identity = currentIdentity() ?: throw IOException("Desktop not paired")
    if (DesktopIdentityRules.validate(identity.host, identity.port, identity.certificatePem) != identity) throw IOException("Invalid desktop identity")
    val key = currentKey() ?: throw IOException("Client identity unavailable")
    val trust = DesktopTlsTrust.fromRegistry(currentIdentity)
    val context = SSLContext.getInstance("TLS").apply { init(arrayOf(key), arrayOf(trust), null) }
    val client = OkHttpClient.Builder().sslSocketFactory(context.socketFactory, trust)
      .dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
          if (hostname != "ispm.local") throw IOException("Invalid host")
          return listOf(resolveAddress(identity.host))
        }
      })
      .proxy(Proxy.NO_PROXY).protocols(listOf(Protocol.HTTP_1_1)).connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
      .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
      .connectTimeout(5, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
    try {
      val url = "https://ispm.local:${identity.port}$path".toHttpUrl()
      val request = Request.Builder().url(url)
      for ((name, value) in headers) request.header(name, value)
      val requestBody = when (method) {
        "POST", "PUT", "PATCH" -> (body ?: ByteArray(0)).toRequestBody()
        "DELETE" -> body?.toRequestBody()
        else -> null
      }
      client.newCall(request.method(method, requestBody).build()).execute().use { response ->
        if (response.code in 300..399) throw IOException("Redirect refused")
        val responseBody = response.body ?: throw IOException("Missing response")
        if (responseBody.contentLength() > MAX_BYTES) throw IOException("Response too large")
        val buffer = Buffer()
        val source = responseBody.source()
        while (true) {
          val count = source.read(buffer, minOf(8192L, MAX_BYTES + 1L - buffer.size))
          if (count == -1L) break
          if (buffer.size > MAX_BYTES) throw IOException("Response too large")
        }
        if (currentIdentity() != identity) throw IOException("Pairing changed")
        val responseHeaders = response.headers.names().associateWith { response.header(it).orEmpty() }
        return MobileHttpResponse(response.code, responseHeaders, buffer.readByteArray())
      }
    } catch (error: IllegalArgumentException) {
      throw IOException("Invalid request", error)
    } finally {
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdown()
    }
  }

  private companion object { const val MAX_BYTES = 16 * 1024 * 1024 }
}
