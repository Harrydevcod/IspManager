package cv.novatech.ispm.sms

import android.content.Context
import android.telephony.SmsManager

object SmsSender {
  fun send(context: Context, toPhone: String, body: String) {
    val manager = context.getSystemService(SmsManager::class.java)
    val parts = manager.divideMessage(body)
    manager.sendMultipartTextMessage(toPhone, null, parts, null, null)
  }
}
