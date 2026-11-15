package cv.novatech.ispm.sms

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** What a route answered, ready to travel back sealed. */
class RelayReply(val status: Int, val headers: Map<String, String>, val body: ByteArray)

fun interface RelayHttp {
  /** Status code and body text; throws when the relay cannot be reached. */
  fun call(method: String, url: String, token: String, body: String?): Pair<Int, String>
}

/** Remembers which exchanges already ran, so a replayed envelope never runs twice. */
fun interface RelaySeen {
  fun firstUse(id: String, expiresAt: Long, now: Long): Boolean
}

/**
 * The phone's half of the relay (ADR 0024): collects the requests the PC left in
 * this pairing's mailbox, runs them through the same routes as the LAN server and
 * leaves the sealed answers. The relay only ever holds ciphertext.
 */
class RelayClient(
  private val secret: () -> String,
  private val relayUrl: () -> String,
  private val seen: RelaySeen,
  private val execute: (method: String, path: String, nonce: String, body: String) -> RelayReply,
  private val http: RelayHttp = UrlConnectionRelayHttp,
  private val now: () -> Long = System::currentTimeMillis
) {
  /** Answers the relay has not accepted yet: sent again, never computed again. */
  private val unsent = HashMap<String, String>()

  /** One round. Returns how many requests ran. */
  fun pollOnce(): Int {
    val secret = secret()
    val url = relayUrl().trimEnd('/')
    if (url.isBlank() || !SECRET.matches(secret)) return 0
    val keys = RelayCrypto.deriveKeys(secret)
    val base = "$url/m/${keys.mailbox.toHex()}"
    val token = keys.phone.toHex()

    val (code, text) = http.call("GET", "$base/requests", token, null)
    if (code != 200) return 0
    val list = JSONObject(text).optJSONArray("requests") ?: return 0
    val listed = HashSet<String>()
    var ran = 0
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      val id = item.optString("id")
      listed += id
      runCatching {
        val answer = unsent[id] ?: run {
          val raw = item.getJSONObject("envelope")
          val envelope = RelayEnvelope(raw.getInt("version"), raw.getLong("expiresAt"), raw.getString("nonce"), raw.getString("ciphertext"), raw.getString("tag"))
          val plain = RelayCrypto.open(secret, "request", id, envelope, now())
          // Recorded before it runs: whatever happens next, this envelope is spent.
          if (!seen.firstUse(id, envelope.expiresAt, now())) return@runCatching
          val cut = plain.indexOf('\n'.code.toByte())
          require(cut > 0) { "pedido invalido" }
          val meta = JSONObject(String(plain, 0, cut, Charsets.UTF_8))
          val reply = execute(meta.getString("method"), meta.getString("path"), meta.optString("nonce"), String(plain, cut + 1, plain.size - cut - 1, Charsets.UTF_8))
          ran++
          val head = JSONObject().put("status", reply.status).put("headers", JSONObject(reply.headers)).toString()
          val sealed = RelayCrypto.seal(secret, "response", id, now() + LIFETIME_MS, head.toByteArray(Charsets.UTF_8) + '\n'.code.toByte() + reply.body)
          JSONObject()
            .put("version", sealed.version).put("expiresAt", sealed.expiresAt)
            .put("nonce", sealed.nonce).put("ciphertext", sealed.ciphertext).put("tag", sealed.tag)
            .toString().also { unsent[id] = it }
        }
        val (posted, _) = http.call("POST", "$base/responses/$id", token, answer)
        // 5xx may still work on the next round; anything else is final.
        if (posted < 500) unsent.remove(id)
        Unit
      }
    }
    // The PC gave up on these (or they expired): nothing left to deliver.
    unsent.keys.retainAll(listed)
    return ran
  }

  companion object {
    private const val LIFETIME_MS = 2 * 60_000L
    private val SECRET = Regex("^[0-9a-fA-F]{64}$")

    /** Blank turns the relay off; otherwise plain HTTPS with no credentials or query. */
    fun acceptableUrl(url: String): Boolean {
      if (url.isEmpty()) return true
      if (url.length > 300) return false
      val uri = runCatching { URI(url) }.getOrNull() ?: return false
      return uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null
    }
  }
}

object UrlConnectionRelayHttp : RelayHttp {
  override fun call(method: String, url: String, token: String, body: String?): Pair<Int, String> {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = 8_000
    connection.readTimeout = 8_000
    connection.setRequestProperty("authorization", "Bearer $token")
    if (body != null) {
      connection.doOutput = true
      connection.setRequestProperty("content-type", "application/json")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    }
    val code = connection.responseCode
    // Read to the end so the connection goes back to the keep-alive pool.
    val text = (if (code < 400) connection.inputStream else connection.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
    return code to text
  }
}

/** Survives a restart: an envelope seen before the process died stays spent until it expires. */
class PrefsRelaySeen(context: Context) : RelaySeen {
  private val prefs = context.getSharedPreferences("relay_seen", Context.MODE_PRIVATE)

  @Synchronized
  override fun firstUse(id: String, expiresAt: Long, now: Long): Boolean {
    val edit = prefs.edit()
    for ((key, value) in prefs.all) if ((value as? Long ?: 0L) <= now) edit.remove(key)
    val fresh = !prefs.contains(id)
    if (fresh) edit.putLong(id, expiresAt)
    // commit, not apply: it must be on disk before the request runs.
    return edit.commit() && fresh
  }
}
