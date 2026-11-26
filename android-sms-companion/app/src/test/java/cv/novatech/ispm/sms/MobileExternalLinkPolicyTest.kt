package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class MobileExternalLinkPolicyTest {
  @Test fun permitsOnlyUserInitiatedMainFrameHttpLinks() {
    assertTrue(MobileExternalLinkPolicy.allows("https://example.com/path", true, true))
    assertTrue(MobileExternalLinkPolicy.allows("http://example.com", true, true))
    for (url in listOf("javascript:alert(1)", "file:///secret", "https://user@example.com/", "https:///path")) {
      assertFalse(MobileExternalLinkPolicy.allows(url, true, true))
    }
    assertFalse(MobileExternalLinkPolicy.allows("https://example.com", false, true))
    assertFalse(MobileExternalLinkPolicy.allows("https://example.com", true, false))
  }
}
