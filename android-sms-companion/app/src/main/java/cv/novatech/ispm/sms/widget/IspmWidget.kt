package cv.novatech.ispm.sms.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import cv.novatech.ispm.sms.IspmSmsApp
import cv.novatech.ispm.sms.MainActivity
import cv.novatech.ispm.sms.R
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules

/** What the home-screen widget says. Pure, so the lock rule is tested without a launcher. */
data class WidgetContent(val cash: String, val down: String, val pending: String)

object WidgetRules {
  /**
   * With the app lock on, the home screen is no place for money: the cash line
   * says only that it is hidden. Counts stay, they say nothing about a client.
   */
  fun content(dashboard: Dashboard?, pending: Int, showAmounts: Boolean): WidgetContent {
    val cash = when {
      dashboard == null -> "Sem resumo do PC"
      !showAmounts -> "Caixa de hoje · oculta (app bloqueada)"
      else -> "Caixa de hoje · ${DashboardRules.formatCve(dashboard.money.cashToday.totalCve)}"
    }
    val downCount = dashboard?.network?.downCount ?: 0
    val down = when {
      dashboard == null -> "Rede · sem dados"
      downCount == 0 -> "Rede · tudo a responder"
      downCount == 1 -> "Rede · 1 equipamento em baixo"
      else -> "Rede · $downCount equipamentos em baixo"
    }
    val pendingLine = when (pending) {
      0 -> "SMS · nada por aprovar"
      1 -> "SMS · 1 por aprovar"
      else -> "SMS · $pending por aprovar"
    }
    return WidgetContent(cash, down, pendingLine)
  }
}

/** Caixa de hoje, quedas e SMS por aprovar no ecrã inicial. Redrawn by the app, never polled. */
class IspmWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val app = context.applicationContext as IspmSmsApp
    val state = app.holder.state.value
    render(context, WidgetRules.content(state.dashboard, state.pending.size, showAmounts = !state.lockEnabled))
  }

  companion object {
    fun render(context: Context, content: WidgetContent) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, IspmWidget::class.java))
      if (ids.isEmpty()) return
      val open = PendingIntent.getActivity(
        context, 1, Intent(context, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val views = RemoteViews(context.packageName, R.layout.widget_ispm).apply {
        setTextViewText(R.id.widget_cash, content.cash)
        setTextViewText(R.id.widget_down, content.down)
        setTextViewText(R.id.widget_pending, content.pending)
        setOnClickPendingIntent(R.id.widget_root, open)
      }
      manager.updateAppWidget(ids, views)
    }
  }
}
