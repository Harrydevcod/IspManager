package cv.novatech.ispm.sms

/** Never let an external picker return an app-private provider or an ungranted URI. */
internal object MobileFileSelectionPolicy {
  fun accepts(scheme: String?, authority: String?, providerUid: Int?, ownUid: Int, readGranted: Boolean): Boolean =
    scheme == "content" && !authority.isNullOrBlank() && providerUid != null && providerUid != ownUid && readGranted
}
