package cv.novatech.ispm.sms

import android.content.Context

/** Device-local choices that never come from the desktop. */
class SettingsStore(context: Context) {
  private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

  /** SIM subscription used to send; null = the phone's default SMS SIM. */
  fun subscriptionId(): Int? = prefs.getInt("subscriptionId", -1).takeIf { it >= 0 }

  fun setSubscriptionId(id: Int?) {
    prefs.edit().putInt("subscriptionId", id ?: -1).apply()
  }

  /** Ask for the fingerprint/PIN to open the app. On by default: client data lives here. */
  fun lockEnabled(): Boolean = prefs.getBoolean("lockEnabled", true)

  fun setLockEnabled(value: Boolean) {
    prefs.edit().putBoolean("lockEnabled", value).apply()
  }

  /** Forward clients' SMS replies to the desktop. Off until the operator turns it on. */
  fun forwardReplies(): Boolean = prefs.getBoolean("forwardReplies", false)

  fun setForwardReplies(value: Boolean) {
    prefs.edit().putBoolean("forwardReplies", value).apply()
  }
}
