package cv.novatech.ispm.sms

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsManager

/**
 * Hands one request to the radio. The outcome arrives later, per part, through
 * [SmsResultReceiver]: SENT when the network accepts it, DELIVERED when the
 * recipient's phone acknowledges it.
 */
object SmsSender {
  fun send(context: Context, request: SmsRequest, subscriptionId: Int?) {
    val manager = managerFor(context, subscriptionId)
    val parts = manager.divideMessage(request.body)
    val sent = ArrayList<PendingIntent>(parts.size)
    val delivered = ArrayList<PendingIntent>(parts.size)
    parts.indices.forEach { i ->
      sent.add(resultIntent(context, SmsResultReceiver.ACTION_SENT, request.id, i, parts.size))
      delivered.add(resultIntent(context, SmsResultReceiver.ACTION_DELIVERED, request.id, i, parts.size))
    }
    manager.sendMultipartTextMessage(request.toPhone, null, parts, sent, delivered)
  }

  private fun managerFor(context: Context, subscriptionId: Int?): SmsManager {
    val base = context.getSystemService(SmsManager::class.java)
    if (subscriptionId == null) return base
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      base.createForSubscriptionId(subscriptionId)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
    }
  }

  private fun resultIntent(context: Context, action: String, id: String, part: Int, total: Int): PendingIntent {
    val intent = Intent(context, SmsResultReceiver::class.java).apply {
      this.action = action
      putExtra(SmsResultReceiver.EXTRA_ID, id)
      putExtra(SmsResultReceiver.EXTRA_PART, part)
      putExtra(SmsResultReceiver.EXTRA_TOTAL, total)
    }
    // Distinct request code per (request, part, kind) so PendingIntents never collapse.
    val code = (id.hashCode() * 31 + part) * 2 + if (action == SmsResultReceiver.ACTION_SENT) 0 else 1
    return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
