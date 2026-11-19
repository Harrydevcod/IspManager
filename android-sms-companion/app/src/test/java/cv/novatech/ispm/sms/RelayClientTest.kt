package cv.novatech.ispm.sms

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import cv.novatech.ispm.sms.state.RelayPoll
import org.junit.Test

class RelayClientTest {
  private val secret = "0123456789abcdef".repeat(4)
  private val id = "00000000-0000-4000-8000-000000000001"
  private var clock = 1_800_000_000_000L
  private val keys = RelayCrypto.deriveKeys(secret)

  /** The mailbox as the phone sees it: a list to collect and a place to answer. */
  private inner class FakeRelay : RelayHttp {
    val pending = LinkedHashMap<String, RelayEnvelope>()
    val answers = LinkedHashMap<String, RelayEnvelope>()
    val calls = ArrayList<String>()
    var postStatus = 201
    /** O que a caixa responde ao GET: 200 normalmente, outro código para simular o relé em baixo. */
    var listStatus = 200

    override fun call(method: String, url: String, token: String, body: String?): Pair<Int, String> {
      calls += "$method ${url.substringAfter(keys.mailbox.toHex())}"
      assertTrue(url.startsWith("https://relay.test/m/${keys.mailbox.toHex()}/"))
      assertEquals(keys.phone.toHex(), token)
      if (method == "GET") {
        if (listStatus != 200) return listStatus to ""
        val list = JSONArray()
        pending.forEach { (key, value) -> list.put(JSONObject().put("id", key).put("envelope", json(value))) }
        return 200 to JSONObject().put("requests", list).toString()
      }
      if (postStatus >= 500) return postStatus to ""
      val raw = JSONObject(body!!)
      val key = url.substringAfterLast('/')
      answers[key] = RelayEnvelope(raw.getInt("version"), raw.getLong("expiresAt"), raw.getString("nonce"), raw.getString("ciphertext"), raw.getString("tag"))
      pending.remove(key)
      return postStatus to ""
    }
  }

  private fun json(e: RelayEnvelope) = JSONObject()
    .put("version", e.version).put("expiresAt", e.expiresAt).put("nonce", e.nonce).put("ciphertext", e.ciphertext).put("tag", e.tag)

  private fun request(method: String, path: String, body: String, exchange: String = id): RelayEnvelope {
    val meta = JSONObject().put("method", method).put("path", path).put("nonce", "n-1").toString()
    return RelayCrypto.seal(secret, "request", exchange, clock + 120_000, (meta + "\n" + body).toByteArray(Charsets.UTF_8))
  }

  private val ran = ArrayList<String>()
  private val spent = HashSet<String>()

  private fun client(relay: RelayHttp, url: String = "https://relay.test/", secret: String = this.secret) = RelayClient(
    secret = { secret },
    relayUrl = { url },
    seen = { exchange, _, _ -> spent.add(exchange) },
    execute = { method, path, nonce, body ->
      ran += "$method $path $nonce $body"
      RelayReply(200, mapOf("content-type" to "application/json"), "{\"ok\":\"é\"}".toByteArray(Charsets.UTF_8))
    },
    http = relay,
    now = { clock }
  )

  @Test fun `runs a sealed request and leaves a sealed answer only the PC can open`() {
    val relay = FakeRelay()
    relay.pending[id] = request("POST", "/requests", "{\"requestId\":\"r1\",\"body\":\"Olá\"}")
    assertEquals(RelayPoll.Ok(1), client(relay).pollOnce())
    assertEquals(listOf("POST /requests n-1 {\"requestId\":\"r1\",\"body\":\"Olá\"}"), ran)

    val plain = RelayCrypto.open(secret, "response", id, relay.answers.getValue(id), clock)
    val cut = plain.indexOf('\n'.code.toByte())
    val head = JSONObject(String(plain, 0, cut, Charsets.UTF_8))
    assertEquals(200, head.getInt("status"))
    assertEquals("application/json", head.getJSONObject("headers").getString("content-type"))
    assertEquals("{\"ok\":\"é\"}", String(plain, cut + 1, plain.size - cut - 1, Charsets.UTF_8))
    // Sealed for the other direction: it does not open as a request.
    assertThrows(Exception::class.java) { RelayCrypto.open(secret, "request", id, relay.answers.getValue(id), clock) }
  }

  @Test fun `a replayed envelope never runs twice`() {
    val relay = FakeRelay()
    val envelope = request("POST", "/requests", "{}")
    relay.pending[id] = envelope
    val client = client(relay)
    assertEquals(RelayPoll.Ok(1), client.pollOnce())
    relay.pending[id] = envelope
    assertEquals(RelayPoll.Ok(0), client.pollOnce())
    // Even a fresh process (no memory of the answer) refuses it: the id is spent on disk.
    assertEquals(RelayPoll.Ok(0), client(relay).pollOnce())
    assertEquals(1, ran.size)
  }

  @Test fun `an answer the relay did not take is sent again, not computed again`() {
    val relay = FakeRelay()
    relay.pending[id] = request("POST", "/requests", "{}")
    relay.postStatus = 503
    val client = client(relay)
    assertEquals(RelayPoll.Ok(1), client.pollOnce())
    assertTrue(relay.answers.isEmpty())
    relay.postStatus = 201
    assertEquals(RelayPoll.Ok(0), client.pollOnce())
    assertEquals(1, ran.size)
    assertNotNull(relay.answers[id])
  }

  @Test fun `ignores what it cannot authenticate - tampered, expired, or for another exchange`() {
    val relay = FakeRelay()
    relay.pending["00000000-0000-4000-8000-000000000003"] = request("GET", "/status", "", "00000000-0000-4000-8000-000000000003")
    clock += 121_000
    val good = request("GET", "/status", "")
    val nonce = if (good.nonce.startsWith("A")) "B" + good.nonce.drop(1) else "A" + good.nonce.drop(1)
    relay.pending[id] = good.copy(nonce = nonce)
    relay.pending["00000000-0000-4000-8000-000000000002"] = good
    assertEquals(RelayPoll.Ok(0), client(relay).pollOnce())
    assertTrue(ran.isEmpty())
    assertTrue(spent.isEmpty())
    assertTrue(relay.answers.isEmpty())
  }

  @Test fun `stays silent without a relay address or with a v1 pairing`() {
    val relay = FakeRelay()
    assertEquals(RelayPoll.Off, client(relay, url = "").pollOnce())
    assertEquals(RelayPoll.Off, client(relay, secret = "segredo-v1").pollOnce())
    assertTrue(relay.calls.isEmpty())
  }

  @Test fun `only accepts a plain https relay address`() {
    assertTrue(RelayClient.acceptableUrl(""))
    assertTrue(RelayClient.acceptableUrl("https://rele.exemplo.workers.dev"))
    assertFalse(RelayClient.acceptableUrl("http://rele.exemplo.workers.dev"))
    assertFalse(RelayClient.acceptableUrl("https://user:pass@rele.exemplo.dev"))
    assertFalse(RelayClient.acceptableUrl("https://rele.exemplo.dev/?k=1"))
    assertFalse(RelayClient.acceptableUrl("rele"))
  }

  @Test fun `uma resposta que nao e 200 e uma falha, nao uma caixa vazia`() {
    val relay = FakeRelay()
    relay.listStatus = 503
    assertEquals(RelayPoll.Failed("Relé com problema (503)"), client(relay).pollOnce())

    relay.listStatus = 403
    assertEquals(RelayPoll.Failed("Pareamento recusado pelo relé"), client(relay).pollOnce())
  }

  @Test fun `sem rede a volta falha, com a razao a vista`() {
    val morto = object : RelayHttp {
      override fun call(method: String, url: String, token: String, body: String?): Pair<Int, String> =
        throw java.io.IOException("Unable to resolve host")
    }
    assertEquals(RelayPoll.Failed("Unable to resolve host"), client(morto).pollOnce())
  }
}
