package cv.novatech.ispm.sms.state

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingPayloadTest {
  @Test fun parsesSecretAndDevice() {
    val info = parsePairingPayload("ispm-sms://pair?secret=9f3a&device=Loja%20Praia") as PairingInfo.V1
    assertEquals("9f3a", info.secret)
    assertEquals("Loja Praia", info.deviceName)
  }

  @Test fun defaultsDeviceWhenMissing() {
    assertEquals("ISPM Desktop", parsePairingPayload("ispm-sms://pair?secret=abc")?.deviceName)
  }

  @Test fun rejectsWrongSchemeOrMissingSecret() {
    assertNull(parsePairingPayload("https://example.com?secret=abc"))
    assertNull(parsePairingPayload("ispm-sms://pair?device=Loja"))
    assertNull(parsePairingPayload("garbage"))
  }

  private val pub = "BLLDVllTSnT_zl6OMuZ5sovQc6eI-vIONr41V4AoRoYVFfHTzbX6qGfBWltHik1t2KvgRr4T2QwZiZV-GcwuBgw"
  private val token = "AQIDBAUGBwgJCgsMDQ4PEA"

  @Test fun parsesV2PublicKeyTokenAndName() {
    val info = parsePairingPayload("ispm-sms://pair?v=2&k=$pub&t=$token&n=LOJA-PC") as PairingInfo.V2
    assertEquals("LOJA-PC", info.deviceName)
    assertArrayEquals(ByteArray(16) { (it + 1).toByte() }, info.token)
    assertEquals(65, info.desktopPub.size)
  }

  @Test fun rejectsV2WithABadKeyOrToken() {
    assertNull(parsePairingPayload("ispm-sms://pair?v=2&k=AAAA&t=$token&n=PC"))
    assertNull(parsePairingPayload("ispm-sms://pair?v=2&k=$pub&t=AQID&n=PC"))
    assertNull(parsePairingPayload("ispm-sms://pair?v=2&t=$token"))
  }
}
