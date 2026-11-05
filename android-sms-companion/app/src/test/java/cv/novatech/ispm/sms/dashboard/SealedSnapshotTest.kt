package cv.novatech.ispm.sms.dashboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SealedSnapshotTest {
  // Same vector the desktop seals in src/backend/lib/companion-crypto.test.ts.
  private val secret = "segredo-de-teste"
  private val sealed = """{"enc":"aes-256-gcm","iv":"AQIDBAUGBwgJCgsM","data":"g8h06HbYC4pX0lrlwBcc9ajUiTEtUMENMHyQNBUfQ2vUJJ3SKx+ARNzhFcg6xn8/smo/PdWmTWtW"}"""

  @Test fun opensWhatTheDesktopSealed() {
    assertEquals("""{"schemaVersion":1,"companyName":"Teste"}""", SealedSnapshot.open(sealed, secret))
  }

  @Test fun anotherPairingCannotOpenIt() {
    assertNull(SealedSnapshot.open(sealed, "outro-segredo"))
    assertNull(SealedSnapshot.open(sealed, ""))
  }

  @Test fun aTamperedBodyIsRejected() {
    assertNull(SealedSnapshot.open(sealed.replace("g8h06", "g8h07"), secret))
  }

  @Test fun anOlderDesktopSendsPlainJson() {
    val plain = """{"schemaVersion":1}"""
    assertEquals(plain, SealedSnapshot.open(plain, secret))
    assertNull(SealedSnapshot.open("not json", secret))
  }
}
