package cv.novatech.ispm.sms.dashboard

import android.content.Context

/** Last snapshot pushed by the desktop. Private prefs; the app has allowBackup=false. */
class DashboardStore(context: Context) {
  private val prefs = context.getSharedPreferences("dashboard", Context.MODE_PRIVATE)

  @Synchronized fun save(raw: String, receivedAt: Long) {
    prefs.edit().putString("raw", raw).putLong("receivedAt", receivedAt).apply()
  }

  fun raw(): String? = prefs.getString("raw", null)
  fun receivedAt(): Long? = prefs.getLong("receivedAt", 0L).takeIf { it > 0L }
  fun load(): Dashboard? = raw()?.let(Dashboard::parse)

  /** Severity of the previous snapshot, to alert only on the change into red. */
  fun lastSeverity(): String? = prefs.getString("lastSeverity", null)
  fun setLastSeverity(value: String) { prefs.edit().putString("lastSeverity", value).apply() }

  fun clear() = prefs.edit().clear().apply()
}
