package cv.novatech.ispm.sms

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Alerts the operator when the desktop queues a new SMS so it can be approved
 * even while the app is backgrounded. The companion HTTP server runs in-process,
 * so this is posted from the server thread the moment a request arrives.
 */
object Notifications {
  const val CHANNEL_ID = "sms_requests"
  private const val NOTIF_ID = 4201

  fun ensureChannel(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Pedidos de SMS",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Avisa quando o desktop envia um novo pedido de SMS para aprovar."
    }
    manager.createNotificationChannel(channel)
  }

  fun notifyNewRequest(context: Context, request: SmsRequest) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val who = request.clientName ?: request.toPhone
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_email)
      .setContentTitle("Novo pedido de SMS")
      .setContentText("$who — toca para aprovar")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(pending)
      .build()
    manager.notify(NOTIF_ID, notification)
  }
}
