package cv.novatech.ispm.sms

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.FieldRules
import cv.novatech.ispm.sms.dashboard.NetworkChanges

/**
 * Two channels: a quiet persistent one for the foreground service, and a
 * high-importance one that alerts the operator when the desktop queues an SMS.
 */
object Notifications {
  const val CHANNEL_ID = "sms_requests"
  const val SERVICE_CHANNEL_ID = "companion_service"
  const val SERVICE_NOTIF_ID = 4200
  const val ALERT_CHANNEL_ID = "ops_alerts"
  private const val NOTIF_ID = 4201
  private const val ALERT_NOTIF_ID = 4202
  const val NETWORK_CHANNEL_ID = "network"
  private const val NETWORK_SUMMARY_ID = 4203
  private const val NETWORK_BASE_ID = 10_000
  const val CALLER_CHANNEL_ID = "callers"
  private const val CALLER_NOTIF_ID = 4204

  fun ensureChannels(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Pedidos de SMS", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Avisa quando o desktop envia um novo pedido de SMS para aprovar."
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(ALERT_CHANNEL_ID, "Alertas da operação", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Avisa quando o estado da operação no desktop passa a crítico."
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(NETWORK_CHANNEL_ID, "Quedas na rede", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Avisa quando uma antena ou equipamento cai e quando volta."
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(CALLER_CHANNEL_ID, "Quem está a ligar", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Diz que cliente está a ligar e quanto deve, com os dados do último resumo."
        setSound(null, null)
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
      // The client's name stays off the lock screen.
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .setContentIntent(openApp(context))
      .build()
    manager.notify(NOTIF_ID, notification)
  }

  /**
   * One notification per device that fell or came back (the same id, so "voltou"
   * replaces "caiu"), or a single summary when a whole area changes at once.
   * Private on the lock screen: device and client names are not for passers-by.
   */
  fun notifyNetworkChanges(context: Context, changes: NetworkChanges) {
    if (changes.count == 0) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    fun build(title: String, text: String, warning: Boolean) = NotificationCompat.Builder(context, NETWORK_CHANNEL_ID)
      .setSmallIcon(if (warning) android.R.drawable.stat_sys_warning else android.R.drawable.stat_sys_upload_done)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(
        NotificationCompat.Builder(context, NETWORK_CHANNEL_ID)
          .setSmallIcon(android.R.drawable.stat_sys_warning)
          .setContentTitle("Alteração na rede")
          .build()
      )
      .setAutoCancel(true)
      .setContentIntent(openApp(context))
      .build()

    if (changes.count > FieldRules.MAX_SINGLE_ALERTS) {
      val parts = listOfNotNull(
        changes.wentDown.size.takeIf { it > 0 }?.let { "$it em baixo" },
        changes.restored.size.takeIf { it > 0 }?.let { "$it voltaram" }
      )
      val names = (changes.wentDown.map { it.name } + changes.restored.map { it.down.name }).take(6).joinToString(", ")
      manager.notify(NETWORK_SUMMARY_ID, build("Rede: ${parts.joinToString(" · ")}", names, changes.wentDown.isNotEmpty()))
      return
    }
    changes.wentDown.forEach { d ->
      manager.notify(networkId(d), build("${d.name} caiu", "Sem resposta à sonda do ISPM.", warning = true))
    }
    changes.restored.forEach { r ->
      val after = r.minutesDown?.let { m -> if (m < 60) " ao fim de $m min" else " ao fim de ${m / 60} h ${m % 60} min" } ?: ""
      manager.notify(networkId(r.down), build("${r.down.name} voltou", "Responde de novo$after.", warning = false))
    }
  }

  private fun networkId(d: cv.novatech.ispm.sms.dashboard.Dashboard.Down) = NETWORK_BASE_ID + (d.key.hashCode() and 0xFFFF)

  /**
   * Who is calling, from the snapshot. Private on the lock screen, like every client
   * name; with the app lock on, the debt and status stay inside the app (same rule as the widget).
   */
  fun notifyCaller(context: Context, client: Dashboard.Client, showAmounts: Boolean) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val debt = if (client.overdueCve > 0) "deve ${DashboardRules.formatCve(client.overdueCve)} vencidos" else "sem dívida vencida"
    val status = if (client.status == "suspended") "suspenso · " else ""
    val text = if (showAmounts) listOfNotNull(client.code.ifBlank { null }, client.plan, status + debt).joinToString(" · ")
    else listOfNotNull(client.code.ifBlank { null }, "abra a app para ver a ficha").joinToString(" · ")
    val notification = NotificationCompat.Builder(context, CALLER_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_call_incoming)
      .setContentTitle("A ligar: ${client.name}")
      .setContentText(text)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(
        NotificationCompat.Builder(context, CALLER_CHANNEL_ID)
          .setSmallIcon(android.R.drawable.sym_call_incoming)
          .setContentTitle("Cliente ISPM a ligar")
          .build()
      )
      .setTimeoutAfter(2 * 60_000L)
      .setAutoCancel(true)
      .setContentIntent(openApp(context))
      .build()
    manager.notify(CALLER_NOTIF_ID, notification)
  }

  fun notifyOperationAlert(context: Context, headline: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val notification = NotificationCompat.Builder(context, ALERT_CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle("Operação em estado crítico")
      .setContentText(headline)
      .setStyle(NotificationCompat.BigTextStyle().bigText(headline))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(openApp(context))
      .build()
    manager.notify(ALERT_NOTIF_ID, notification)
  }

  private fun openApp(context: Context): PendingIntent {
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
