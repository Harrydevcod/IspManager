package cv.novatech.ispm.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Brings the server back after a reboot, without anyone opening the app. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      IspmSmsApp.startService(context)
    }
  }
}
