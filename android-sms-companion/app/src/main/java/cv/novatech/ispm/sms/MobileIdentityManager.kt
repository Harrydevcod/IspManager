package cv.novatech.ispm.sms

/** An existing but unreadable identity must throw, not be treated as missing. */
interface MobileIdentityBackend {
  fun read(alias: String): ByteArray?
  fun create(alias: String): ByteArray
  fun delete(alias: String)
}

class MobileIdentityManager(private val backend: MobileIdentityBackend) {
  @Synchronized fun certificatePem(secret: String): String? {
    val alias = MobileIdentityRules.aliasFor(secret) ?: return null
    return runCatching {
      val certificate = backend.read(alias) ?: backend.create(alias)
      MobileIdentityRules.certificatePem(certificate)
    }.getOrNull()
  }

  @Synchronized fun forget(secret: String) {
    val alias = MobileIdentityRules.aliasFor(secret) ?: return
    runCatching { backend.delete(alias) }
  }
}
