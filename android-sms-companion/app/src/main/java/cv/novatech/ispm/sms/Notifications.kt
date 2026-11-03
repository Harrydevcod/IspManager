package cv.novatech.ispm.sms

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * Two channels: a quiet persistent one for the foreground service, and a
 * high-importance one that alerts the operator when the desktop queues an SMS.
 */
object Notifications {
  const val CHANNEL_ID = "sms_requests"
  const val SERVICE_CHANNEL_ID = "companion_service"
  const val SERVICE_NOTIF_ID = 4200
  private const val NOTIF_ID = 4201

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Pedidos de SMS", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Avisa quando o desktop envia um novo pedido de SMS para aprovar."
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(SERVICE_CHANNEL_ID, "Servidor ativo", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Mantém o ISPM SMS a ouvir o desktop com o ecrã apagado."
        setShowBadge(false)
      }
    )
  }

  fun serviceNotification(context: Context, address: String): Notification =
    NotificationCompat.Builder(context, SERVICE_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
      .setContentTitle("A aguardar pedidos")
      .setContentText(address)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(openApp(context))
      .build()

  fun notifyNewRequest(context: Context, request: SmsRequest) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val who = request.clientName ?: request.toPhone
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_email)
      .setContentTitle("Novo pedido de SMS")
      .setContentText("$who — toca para aprovar")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setContentIntent(openApp(context))
      .build()
    manager.notify(NOTIF_ID, notification)
  }

  private fun openApp(context: Context): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
