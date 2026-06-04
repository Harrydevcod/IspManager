package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingPayloadTest {
  @Test fun parsesSecretAndDevice() {
    val info = parsePairingPayload("ispm-sms://pair?secret=9f3a&device=Loja%20Praia")
    assertEquals("9f3a", info?.secret)
    assertEquals("Loja Praia", info?.deviceName)
  }

  @Test fun defaultsDeviceWhenMissing() {
    assertEquals("ISPM Desktop", parsePairingPayload("ispm-sms://pair?secret=abc")?.deviceName)
  }

  @Test fun rejectsWrongSchemeOrMissingSecret() {
    assertNull(parsePairingPayload("https://example.com?secret=abc"))
    assertNull(parsePairingPayload("ispm-sms://pair?device=Loja"))
    assertNull(parsePairingPayload("garbage"))
  }
}
