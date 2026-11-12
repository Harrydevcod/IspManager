package cv.novatech.ispm.sms

import android.content.Context
import cv.novatech.ispm.sms.send.SendBudget
import cv.novatech.ispm.sms.send.SimLimits
import cv.novatech.ispm.sms.state.ThemePref
import cv.novatech.ispm.sms.state.ThemeRules

/** Device-local choices that never come from the desktop. */
class SettingsStore(context: Context) {
  private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

  /** SIM subscription used to send; null = the phone's default SMS SIM (or alternating, see [rotateSims]). */
  fun subscriptionId(): Int? = prefs.getInt("subscriptionId", -1).takeIf { it >= 0 }

  /** "Automático (alternar)": each SMS goes on the SIM with the most room. */
  fun rotateSims(): Boolean = prefs.getInt("subscriptionId", -1) == SendBudget.ROTATE

  /** Sending pace per SIM (SimLimits.PRESETS); the prudent one by default. */
  fun simPace(): Int = prefs.getInt("simPace", 0).coerceIn(0, SimLimits.PRESETS.lastIndex)

  fun setSimPace(index: Int) {
    prefs.edit().putInt("simPace", index).apply()
  }

  fun simLimits(): SimLimits = SimLimits.PRESETS[simPace()].second

  fun setSubscriptionId(id: Int?) {
    prefs.edit().putInt("subscriptionId", id ?: -1).apply()
  }

  /** Ask for the fingerprint/PIN to open the app. On by default: client data lives here. */
  fun lockEnabled(): Boolean = prefs.getBoolean("lockEnabled", true)

  fun setLockEnabled(value: Boolean) {
    prefs.edit().putBoolean("lockEnabled", value).apply()
  }

  fun themePref(): ThemePref = ThemeRules.parse(prefs.getString("theme", null))

  fun setThemePref(value: ThemePref) {
    prefs.edit().putString("theme", value.name).apply()
  }
}
