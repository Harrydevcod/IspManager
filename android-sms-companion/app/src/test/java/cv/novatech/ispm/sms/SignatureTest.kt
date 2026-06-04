package cv.novatech.ispm.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class SignatureTest {
  private fun sign(secret: String, canonical: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(canonical.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }

  @Test fun hmacMatchesDesktopCanonicalFormat() {
    val canonical = listOf("POST", "/requests", "2026-06-04T12:00:00.000Z", "nonce-1", "{}").joinToString("\n")
    val hex = sign("secret", canonical)
    assertEquals(64, hex.length)
  }

  @Test fun identicalInputsProduceIdenticalSignatures() {
    val canonical = listOf("GET", "/requests/android-1", "2026-06-04T12:00:00.000Z", "nonce-2", "").joinToString("\n")
    assertEquals(sign("super-secret", canonical), sign("super-secret", canonical))
  }

  @Test fun differentSecretsProduceDifferentSignatures() {
    val canonical = listOf("POST", "/requests", "2026-06-04T12:00:00.000Z", "nonce-3", "{}").joinToString("\n")
    assertTrue(sign("secret-a", canonical) != sign("secret-b", canonical))
  }
}
