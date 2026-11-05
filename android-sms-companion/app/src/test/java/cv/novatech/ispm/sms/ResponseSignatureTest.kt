package cv.novatech.ispm.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ResponseSignatureTest {
  // Same vector as src/backend/lib/sms-signing.test.ts: the desktop rejects anything else.
  @Test fun matchesTheDesktopVector() {
    assertEquals(
      "f9ab63dd1cc695c7658ace95303eafc636a131ebd6c5d126b2d34c8b40537eb3",
      ResponseSignature.sign("segredo-de-teste", "nonce-1234", """{"events":[]}""".toByteArray(Charsets.UTF_8))
    )
  }

  @Test fun theNonceBindsTheResponseToItsRequest() {
    val body = """{"events":[]}""".toByteArray(Charsets.UTF_8)
    assertNotEquals(ResponseSignature.sign("s", "a", body), ResponseSignature.sign("s", "b", body))
  }
}
