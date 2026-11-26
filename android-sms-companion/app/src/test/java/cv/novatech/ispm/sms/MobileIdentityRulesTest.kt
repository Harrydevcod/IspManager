package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class MobileIdentityRulesTest {
  private val secret = "ab".repeat(32)

  @Test fun aliasIsStableBoundToThePairingAndDoesNotContainTheSecret() {
    val alias = requireNotNull(MobileIdentityRules.aliasFor(secret))
    assertEquals(alias, MobileIdentityRules.aliasFor(secret.uppercase()))
    assertNotEquals(alias, MobileIdentityRules.aliasFor("cd".repeat(32)))
    assertFalse(alias.contains(secret))
    assertTrue(alias.startsWith("ispm-mobile-v1-"))
  }

  @Test fun rejectsInvalidSecretsAndInvalidCertificates() {
    assertNull(MobileIdentityRules.aliasFor(""))
    assertNull(MobileIdentityRules.aliasFor("not-hex"))
    assertNull(MobileIdentityRules.certificatePem(ByteArray(0)))
    assertNull(MobileIdentityRules.certificatePem(ByteArray(8193)))
  }

  @Test fun certificatePemUsesStandardEncoding() {
    assertEquals("-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n", MobileIdentityRules.certificatePem(byteArrayOf(1,2,3)))
  }

  @Test fun certificateProofIsOnlyAvailableOnLanForV2GetRequests() {
    val path = "/mobile/device-certificate"
    assertTrue(MobileIdentityRules.allowProof(true, "GET", path, 2))
    assertFalse(MobileIdentityRules.allowProof(false, "GET", path, 2))
    assertFalse(MobileIdentityRules.allowProof(true, "POST", path, 2))
    assertFalse(MobileIdentityRules.allowProof(true, "GET", path, 1))
    assertFalse(MobileIdentityRules.allowProof(true, "GET", "/other", 2))
  }
}
