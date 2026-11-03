package cv.novatech.ispm.sms

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Receives the radio's per-part SENT and DELIVERED reports and records them. */
class SmsResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(EXTRA_ID) ?: return
    val part = intent.getIntExtra(EXTRA_PART, 0)
    val total = intent.getIntExtra(EXTRA_TOTAL, 1)
    val app = context.applicationContext as IspmSmsApp
    val now = System.currentTimeMillis()
    when (intent.action) {
      ACTION_SENT -> app.requestStore.update(id) {
        RequestRules.onSentResult(it, resultCode == Activity.RESULT_OK, part == total - 1, resultCode, now)
      }
      ACTION_DELIVERED -> if (part == total - 1) app.requestStore.update(id) { RequestRules.onDelivered(it, now) }
    }
    app.holder.refresh()
  }

  companion object {
    const val ACTION_SENT = "cv.novatech.ispm.sms.SENT"
    const val ACTION_DELIVERED = "cv.novatech.ispm.sms.DELIVERED"
    const val EXTRA_ID = "requestId"
    const val EXTRA_PART = "part"
    const val EXTRA_TOTAL = "total"
  }
}
