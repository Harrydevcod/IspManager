package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException

class MobileHealthProbeTest {
  private val body = """{"ok":true,"service":"ispm-backend"}"""
  private fun response(status: String = "200 OK", headers: String = "Content-Length: ${body.toByteArray().size}\r\n", payload: String = body) =
    ByteArrayInputStream("HTTP/1.1 $status\r\n${headers}\r\n$payload".toByteArray(Charsets.US_ASCII))

  @Test fun acceptsOnlyACompleteHealthyBackendResponse() {
    assertTrue(MobileHealthProbe.readResponse(response()))
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(status = "503 Service Unavailable")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(payload = "{}")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(payload = body.replace("true", "false"))) }
  }

  @Test fun rejectsAmbiguousOversizedAndTruncatedResponses() {
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(headers = "Content-Length: 5000\r\n")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(headers = "Content-Length: 2\r\nContent-Length: 2\r\n", payload = "{}")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(headers = "Transfer-Encoding: chunked\r\n")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(response(headers = "Content-Length: 500\r\n")) }
    assertThrows(IOException::class.java) { MobileHealthProbe.readResponse(ByteArrayInputStream(ByteArray(9000) { 65 })) }
  }
}
