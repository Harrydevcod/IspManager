package cv.novatech.ispm.sms

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps the LAN server alive with the screen off and
 * the Activity gone. Type `specialUse`: `dataSync` is capped at 6 h/day on
 * Android 15 and may not start from BOOT_COMPLETED.
 */
class CompanionService : Service() {
  private var server: CompanionServer? = null
  private var watcher: Job? = null
  private var relay: Job? = null

  override fun onCreate() {
    super.onCreate()
    val app = application as IspmSmsApp
    goForeground(app.holder.state.value.listenAddress)

    server = CompanionServer(
      app.pairingStore,
      app.requestStore,
      onRequestsChanged = { request ->
        app.holder.refresh()
        Notifications.notifyNewRequest(this, request)
      },
      statusProvider = app::deviceStatusJson,
      onDashboard = app::acceptDashboard,
      onAuthenticated = { app.holder.markDesktopSeen() },
      onRejected = { app.holder.markDesktopRejected() },
      eventStore = app.eventStore,
      pendingPairing = { app.holder.pendingPairing },
      onPairConfirmed = { app.holder.completePairing(it) },
      model = listOf(Build.MANUFACTURER, Build.MODEL).distinct().joinToString(" ").trim().ifBlank { "Telemóvel" }
    )
    val started = runCatching { server?.start() }.isSuccess
    app.holder.setServerRunning(started)

    // Out of the PC's reach on the LAN: collect its requests from the relay (ADR 0024).
    val client = RelayClient(
      secret = { if (app.pairingStore.version() == 2) app.pairingStore.secret() else "" },
      relayUrl = app.pairingStore::relayUrl,
      seen = PrefsRelaySeen(this),
      execute = { method, path, nonce, body -> server!!.relayReply(method, path, nonce, body) }
    )
    relay = app.scope.launch(Dispatchers.IO) {
      var busyUntil = 0L
      while (isActive) {
        val now = System.currentTimeMillis()
        val lanQuiet = now - (server?.lastLanAt ?: 0L) > LAN_QUIET_MS
        val ran = if (lanQuiet) runCatching { client.pollOnce() }.getOrDefault(0) else 0
        if (ran > 0) busyUntil = now + BUSY_MS
        // ponytail: fixed polling; long-poll if the wait or the battery ever matters.
        delay(if (now < busyUntil || ran > 0) BUSY_POLL_MS else IDLE_POLL_MS)
      }
    }

    // Keep the persistent notification's address in step with the network.
    watcher = app.scope.launch {
      app.holder.state.map { it.listenAddress }.distinctUntilChanged().collect { goForeground(it) }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    watcher?.cancel()
    relay?.cancel()
    server?.stop()
    (application as IspmSmsApp).holder.setServerRunning(false)
    super.onDestroy()
  }

  private companion object {
    /** The PC asks for /status every minute on the LAN; quieter than this, it is not reaching us. */
    const val LAN_QUIET_MS = 90_000L
    const val IDLE_POLL_MS = 15_000L
    /** While requests are flowing (a queue of SMS), answer quickly. */
    const val BUSY_POLL_MS = 2_000L
    const val BUSY_MS = 30_000L
  }

  private fun goForeground(address: String) {
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    } else {
      0
    }
    ServiceCompat.startForeground(this, Notifications.SERVICE_NOTIF_ID, Notifications.serviceNotification(this, address), type)
  }
}
