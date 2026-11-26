package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test

class DesktopIdentityRegistryTest {
  private fun fixture(name:String) = requireNotNull(javaClass.getResourceAsStream("/mobile-identity/$name.pem")).bufferedReader().use { it.readText() }
  private class MemoryStore : DesktopIdentityRepository {
    var value: String? = null
    override fun read(): String? = value
    override fun write(record: String): Boolean { value = record; return true }
  }

  @Test fun recordsOnlyTheCurrentPairingAndAllowsAddressChangesButNotCertificateChanges() {
    val store = MemoryStore()
    var pairing = DesktopPairing(2, "ab".repeat(32))
    val registry = DesktopIdentityRegistry(store) { pairing }
    val cert = fixture("desktop-valid")
    assertEquals(DesktopIdentityResult.SAVED, registry.register(pairing.secret, "192.168.1.20", 38421, cert))
    val first = requireNotNull(registry.current())
    assertEquals(DesktopIdentityResult.SAVED, registry.register(pairing.secret, "192.168.1.21", 38421, cert))
    assertEquals("192.168.1.21", registry.current()?.host)
    assertEquals(first.fingerprintSha256, registry.current()?.fingerprintSha256)
    assertEquals(DesktopIdentityResult.CONFLICT, registry.register(pairing.secret, "192.168.1.21", 38421, fixture("desktop-other-valid")))
    assertEquals(first.fingerprintSha256, registry.current()?.fingerprintSha256)
    pairing = DesktopPairing(2, "cd".repeat(32))
    assertNull(registry.current())
    assertEquals(DesktopIdentityResult.PAIRING_CHANGED, registry.register("ab".repeat(32), "192.168.1.20", 38421, cert))
  }

  @Test fun rejectsLegacyAndCorruptionWithoutOverwriting() {
    val store = MemoryStore()
    var pairing = DesktopPairing(1, "ab".repeat(32))
    val registry = DesktopIdentityRegistry(store) { pairing }
    val cert = fixture("desktop-valid")
    assertEquals(DesktopIdentityResult.PAIRING_CHANGED, registry.register(pairing.secret, "192.168.1.20", 38421, cert))
    assertNull(store.value)
    pairing = DesktopPairing(2, pairing.secret)
    store.value = "corrupt"
    assertNull(registry.current())
    assertEquals(DesktopIdentityResult.CONFLICT, registry.register(pairing.secret, "192.168.1.20", 38421, cert))
    assertEquals("corrupt", store.value)
  }
}
