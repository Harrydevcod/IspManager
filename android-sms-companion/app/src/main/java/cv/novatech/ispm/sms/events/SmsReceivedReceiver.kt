package cv.novatech.ispm.sms.events

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import cv.novatech.ispm.sms.IspmSmsApp
import cv.novatech.ispm.sms.dashboard.ClientRules
import org.json.JSONObject

/**
 * A client's reply to an SMS goes to the desktop's inbox. Only numbers that are
 * clients in the last snapshot are forwarded: anyone else's message (bank codes,
 * family, the operator) never leaves the phone.
 */
class SmsReceivedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val app = context.applicationContext as IspmSmsApp
    if (!app.settingsStore.forwardReplies()) return
    val clients = app.dashboardStore.load()?.clients ?: return
    // A long SMS arrives in parts; join them per sender.
    Telephony.Sms.Intents.getMessagesFromIntent(intent)
      .groupBy { it.originatingAddress.orEmpty() }
      .forEach { (from, parts) ->
        if (ClientRules.byPhone(clients, from) == null) return@forEach
        val body = parts.joinToString("") { it.messageBody.orEmpty() }.take(1600)
        app.eventStore.add(FieldEvent.SMS_IN, JSONObject().put("from", from).put("body", body))
      }
  }
}
