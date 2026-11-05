package cv.novatech.ispm.sms

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import cv.novatech.ispm.sms.dashboard.ClientRules

/**
 * Quem está a ligar: when a client calls, a notification names them and their
 * overdue debt, looked up in the last snapshot on the phone. It never blocks,
 * silences or rejects a call, and nothing leaves the phone. Active only while the
 * operator has given this app the call-screening role (Definições).
 */
class CallerIdService : CallScreeningService() {
  override fun onScreenCall(details: Call.Details) {
    // Let every call through untouched, before anything that could fail.
    respondToCall(details, CallResponse.Builder().build())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && details.callDirection != Call.Details.DIRECTION_INCOMING) return
    val number = details.handle?.schemeSpecificPart ?: return
    val app = application as IspmSmsApp
    val clients = app.dashboardStore.load()?.clients ?: return
    val client = ClientRules.byPhone(clients, number) ?: return
    Notifications.notifyCaller(this, client, showAmounts = !app.settingsStore.lockEnabled())
  }
}
