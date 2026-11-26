package cv.novatech.ispm.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileAssetPolicyTest {
  @Test fun restrictsWebViewToBundledAssets() {
    assertTrue(MobileAssetPolicy.allows("https://appassets.androidplatform.net/assets/ispm/index.html"))
    assertTrue(MobileAssetPolicy.allows("https://appassets.androidplatform.net/assets/ispm/assets/app.js"))
    assertFalse(MobileAssetPolicy.allows("content://other.example/private"))
    assertFalse(MobileAssetPolicy.allows("https://evil.example/assets/ispm/index.html"))
    assertFalse(MobileAssetPolicy.allows("https://appassets.androidplatform.net:443/assets/ispm/index.html"))
    assertFalse(MobileAssetPolicy.allows("https://appassets.androidplatform.net/assets/ispm/../secret"))
    assertFalse(MobileAssetPolicy.allows("https://appassets.androidplatform.net/assets/ispm/%2e%2e/secret"))
    assertFalse(MobileAssetPolicy.allows("https://appassets.androidplatform.net/assets/ispm%2f..%2fsecret"))
    assertFalse(MobileAssetPolicy.allows("https://user@appassets.androidplatform.net/assets/ispm/index.html"))
  }
}
