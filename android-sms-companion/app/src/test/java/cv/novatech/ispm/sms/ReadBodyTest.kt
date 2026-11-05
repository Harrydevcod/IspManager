package cv.novatech.ispm.sms

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.EOFException

class ReadBodyTest {
  @Test fun accentsSurviveSoTheSignatureMatches() {
    val json = """{"companyName":"Skynet","clientName":"João Gonçalves","sim":"CVMóvel"}"""
    val bytes = json.toByteArray(Charsets.UTF_8)
    assertEquals(json, readBody(ByteArrayInputStream(bytes), bytes.size.toLong()))
  }

  @Test fun readsOnlyContentLengthBytes() {
    // Keep-alive: whatever follows the body belongs to the next request.
    assertEquals("{}", readBody(ByteArrayInputStream("{}GET /".toByteArray()), 2))
  }

  @Test fun noBodyIsEmpty() {
    assertEquals("", readBody(ByteArrayInputStream(ByteArray(0)), 0))
  }

  @Test(expected = EOFException::class) fun truncatedBodyFails() {
    readBody(ByteArrayInputStream("{}".toByteArray()), 10)
  }
}
