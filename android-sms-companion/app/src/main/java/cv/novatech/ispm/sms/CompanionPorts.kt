package cv.novatech.ispm.sms

/** The local SMS server only needs these capabilities of the stores. */
interface CompanionPairing {
  fun secret(): String
  fun version(): Int
  fun saveRelayUrl(url: String)
  fun registerDesktopIdentity(expectedSecret: String, host: String, port: Int, pem: String): DesktopIdentityResult
}

interface CompanionRequests {
  fun find(id: String): SmsRequest?
  fun upsert(request: SmsRequest)
}
