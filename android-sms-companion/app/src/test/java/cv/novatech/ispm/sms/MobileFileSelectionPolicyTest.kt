package cv.novatech.ispm.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileFileSelectionPolicyTest {
  @Test fun acceptsOnlyGrantedExternalContent() {
    assertTrue(MobileFileSelectionPolicy.accepts("content", "documents.example", 2000, 1000, true))
    assertFalse(MobileFileSelectionPolicy.accepts("file", "documents.example", 2000, 1000, true))
    assertFalse(MobileFileSelectionPolicy.accepts("content", "", 2000, 1000, true))
    assertFalse(MobileFileSelectionPolicy.accepts("content", "private.example", 1000, 1000, true))
    assertFalse(MobileFileSelectionPolicy.accepts("content", "documents.example", 2000, 1000, false))
    assertFalse(MobileFileSelectionPolicy.accepts("content", "documents.example", null, 1000, true))
  }
}
