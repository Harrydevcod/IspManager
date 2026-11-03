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
}
