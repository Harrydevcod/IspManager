package cv.novatech.ispm.sms

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class MobileBridgeHandlerTest {
  private val origin = "https://appassets.androidplatform.net"

  @Test fun forwardsAuthorizedRequestAndReturnsBinaryResponse() {
    var called = false
    val handler = MobileBridgeHandler { method, path, headers, body ->
      called = true
      assertEquals("POST", method)
      assertEquals("/api/clients", path)
      assertEquals("Bearer test", headers["authorization"])
      assertEquals("{}", String(body!!))
      MobileHttpResponse(200, mapOf("content-type" to "application/octet-stream"), byteArrayOf(0, 1, -1))
    }
    val reply = handler.handle(origin, true, """{"id":"1","method":"POST","path":"/api/clients","headers":{"authorization":"Bearer test"},"body":"e30="}""")
    val result = JSONObject(reply!!)
    assertTrue(called)
    assertEquals("1", result.getString("id"))
    assertEquals(200, result.getInt("status"))
    assertArrayEquals(byteArrayOf(0, 1, -1), Base64.getDecoder().decode(result.getString("body")))
  }

  @Test fun ignoresOtherOriginsAndSubframes() {
    var called = false
    val handler = MobileBridgeHandler { _, _, _, _ -> called = true; throw IllegalStateException() }
    val message = """{"id":"1","method":"GET","path":"/api/clients","headers":{},"body":""}"""
    assertNull(handler.handle("https://evil.example", true, message))
    assertNull(handler.handle(origin, false, message))
    assertFalse(called)
  }

  @Test fun rejectsMalformedAndUnauthorizedHeadersWithoutInvokingClient() {
    var called = false
    val handler = MobileBridgeHandler { _, _, _, _ -> called = true; throw IllegalStateException() }
    val message = """{"id":"1","method":"GET","path":"/api/clients","headers":{"host":"evil.example"},"body":""}"""
    assertTrue(JSONObject(handler.handle(origin, true, message)!!).getBoolean("error"))
    assertNull(handler.handle(origin, true, "not json"))
    assertFalse(called)
  }

  @Test fun returnsGenericErrorWithoutExposingException() {
    val handler = MobileBridgeHandler { _, _, _, _ -> throw IllegalStateException("secret") }
    val result = handler.handle(origin, true, """{"id":"2","method":"GET","path":"/api/clients","headers":{},"body":""}""")!!
    assertTrue(JSONObject(result).getBoolean("error"))
    assertFalse(result.contains("secret"))
  }
}
