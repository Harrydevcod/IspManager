package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class MobileIdentityManagerTest {
  private class FakeBackend : MobileIdentityBackend {
    val keys = mutableMapOf<String, ByteArray>()
    var creates = 0
    var failRead = false
    override fun read(alias: String): ByteArray? {
      if (failRead) throw IllegalStateException("unreadable")
      return keys[alias]
    }
    override fun create(alias: String): ByteArray {
      creates++
      return byteArrayOf(1, 2, 3).also { keys[alias] = it }
    }
    override fun delete(alias: String) { keys.remove(alias) }
  }

  @Test fun createsOnceAndUsesAnotherIdentityForANewPairing() {
    val backend = FakeBackend()
    val manager = MobileIdentityManager(backend)
    val a = "ab".repeat(32)
    val b = "cd".repeat(32)
    assertEquals(manager.certificatePem(a), manager.certificatePem(a))
    assertEquals(1, backend.creates)
    assertNotNull(manager.certificatePem(b))
    assertEquals(2, backend.creates)
    manager.forget(a)
    assertNull(backend.keys[MobileIdentityRules.aliasFor(a)])
    assertNotNull(backend.keys[MobileIdentityRules.aliasFor(b)])
  }

  @Test fun unreadableIdentityFailsClosedWithoutReplacement() {
    val backend = FakeBackend()
    val manager = MobileIdentityManager(backend)
    assertNotNull(manager.certificatePem("ab".repeat(32)))
    backend.failRead = true
    assertNull(manager.certificatePem("ab".repeat(32)))
    assertEquals(1, backend.creates)
    assertNull(manager.certificatePem("invalid"))
    assertEquals(1, backend.creates)
  }
}
