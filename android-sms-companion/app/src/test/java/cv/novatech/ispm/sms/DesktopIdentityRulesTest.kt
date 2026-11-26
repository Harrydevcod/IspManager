package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class DesktopIdentityRulesTest {
  private fun fixture(name: String): String = requireNotNull(javaClass.getResourceAsStream("/mobile-identity/$name.pem"))
    .bufferedReader(Charsets.UTF_8).use { it.readText() }

  @Test fun acceptsThePinnedDesktopCertificateAndAUnicastAddress() {
    val connection = DesktopIdentityRules.validate("192.168.1.20", 38421, fixture("desktop-valid"))
    assertNotNull(connection)
    assertEquals("192.168.1.20", connection?.host)
    assertEquals(38421, connection?.port)
    assertTrue(connection!!.fingerprintSha256.matches(Regex("[0-9a-f]{64}")))
  }

  @Test fun rejectsUntrustedShapesAndInvalidCertificates() {
    val cert = fixture("desktop-valid")
    for (host in listOf("localhost", "127.0.0.1", "0.0.0.0", "224.0.0.1", "192.168.1.020", "192.168.1.256", "192.168.1.20/path")) {
      assertNull(DesktopIdentityRules.validate(host, 38421, cert))
    }
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 0, cert))
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 65536, cert))
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 38421, fixture("desktop-wrong-name")))
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 38421, fixture("desktop-expired")))
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 38421, cert + cert))
    assertNull(DesktopIdentityRules.validate("192.168.1.20", 38421, "not a certificate"))
  }
}
