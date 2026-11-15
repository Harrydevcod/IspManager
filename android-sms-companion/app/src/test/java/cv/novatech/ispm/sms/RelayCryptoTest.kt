package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class RelayCryptoTest {
  private val secret = "0123456789abcdef".repeat(4)
  private val id = "00000000-0000-4000-8000-000000000001"
  private val expiresAt = 1_800_000_000_000L

  @Test fun `opens the independent cross platform vector`() {
    val keys = RelayCrypto.deriveKeys(secret)
    assertEquals("334051549c137c0c31eca46d7f6806af84be45a4637deba355317164ddf39c82", keys.mailbox.toHex())
    assertEquals("a23fc895d405e4f422f9a56ec44949e29531d0944a0f4ebe1fb5c74e6d0741cb", keys.request.toHex())
    val envelope = RelayEnvelope(1, expiresAt, "AAECAwQFBgcICQoL", "KvLyM2B44jhXgOx1p_VbBwjz-42d", "JT6yVllBiZ5TxrFKD6KVcg")
    assertEquals("Olá, pedido de teste", RelayCrypto.open(secret, "request", id, envelope, expiresAt - 1).toString(Charsets.UTF_8))
  }

  @Test fun `rejects a changed direction identifier or expiry`() {
    val envelope = RelayCrypto.seal(secret, "request", id, expiresAt, "teste".toByteArray())
    assertThrows(Exception::class.java) { RelayCrypto.open(secret, "response", id, envelope, expiresAt - 1) }
    assertThrows(Exception::class.java) { RelayCrypto.open(secret, "request", "00000000-0000-4000-8000-000000000002", envelope, expiresAt - 1) }
    assertThrows(Exception::class.java) { RelayCrypto.open(secret, "request", id, envelope, expiresAt) }
    assertThrows(Exception::class.java) { RelayCrypto.open(secret, "request", id, envelope.copy(expiresAt = expiresAt + 1), expiresAt - 1) }
  }
}
