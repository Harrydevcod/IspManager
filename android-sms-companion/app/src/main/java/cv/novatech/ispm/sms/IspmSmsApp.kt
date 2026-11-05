package cv.novatech.ispm.sms

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import androidx.core.content.ContextCompat
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.DashboardStore
import cv.novatech.ispm.sms.dashboard.FieldRules
import cv.novatech.ispm.sms.dashboard.SealedSnapshot
import cv.novatech.ispm.sms.state.CompanionStateHolder
import cv.novatech.ispm.sms.widget.IspmWidget
import cv.novatech.ispm.sms.widget.WidgetRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Process-wide owner of the stores and the state holder. The HTTP server is
 * started by [CompanionService] so it outlives any Activity.
 */
class IspmSmsApp : Application() {
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  lateinit var pairingStore: PairingStore private set
  lateinit var requestStore: SmsRequestStore private set
  lateinit var settingsStore: SettingsStore private set
  lateinit var dashboardStore: DashboardStore private set
  lateinit var holder: CompanionStateHolder private set

  // UI lock (LockRules). Process-wide so a rotation doesn't ask again; a new process starts locked.
  @Volatile var unlocked = false
  @Volatile var backgroundAt: Long? = null

  override fun onCreate() {
    super.onCreate()
    pairingStore = PairingStore(this)
    requestStore = SmsRequestStore(this)
    settingsStore = SettingsStore(this)
    dashboardStore = DashboardStore(this)
    holder = CompanionStateHolder(
      pairingStore = pairingStore,
      requestStore = requestStore,
      scope = scope,
      send = { req -> SmsSender.send(this, req, settingsStore.subscriptionId()) }
    )
    Notifications.ensureChannels(this)

    val now = System.currentTimeMillis()
    var rearm = emptyList<String>()
    requestStore.replaceAll { rows ->
      val (fixed, ids) = RequestRules.recover(RequestRules.prune(rows, now), now)
      rearm = ids
      fixed
    }
    holder.rearm(rearm)
    holder.setDashboard(dashboardStore.load(), dashboardStore.receivedAt())

    // Re-read the LAN address whenever the default network changes (Wi-Fi swap, DHCP renew).
    getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = holder.refresh()
      override fun onLost(network: Network) = holder.refresh()
    })
    holder.refresh()

    // The widget follows the same state as the screens: a new summary, a request, the lock switch.
    scope.launch {
      holder.state
        .map { WidgetRules.content(it.dashboard, it.pending.size, showAmounts = !it.lockEnabled) }
        .distinctUntilChanged()
        .collect { IspmWidget.render(this@IspmSmsApp, it) }
    }
  }

  /** `GET /status`: what the phone tells the desktop about itself. */
  fun deviceStatusJson() = DeviceStatus.read(this, holder.state.value.pending.size).toJson()

  /** `POST /dashboard`: keeps the snapshot and alerts on the change into red. False = rejected. */
  fun acceptDashboard(raw: String): Boolean {
    if (raw.length > Dashboard.MAX_BYTES) return false
    // Sealed by a 2.53+ desktop; stored opened (app-private storage), like before.
    val json = SealedSnapshot.open(raw, pairingStore.secret()) ?: return false
    val dashboard = Dashboard.parse(json) ?: return false
    val now = System.currentTimeMillis()
    // Read the previous snapshot before it is overwritten: the diff is the alert.
    val previousDown = dashboardStore.load()?.network?.downNow
    dashboardStore.save(json, now)
    Notifications.notifyNetworkChanges(this, FieldRules.networkChanges(previousDown, dashboard.network.downNow, now))
    val severity = dashboard.operation.severity
    if (DashboardRules.shouldAlert(dashboardStore.lastSeverity(), severity)) {
      Notifications.notifyOperationAlert(this, dashboard.operation.headline)
    }
    dashboardStore.setLastSeverity(severity)
    holder.setDashboard(dashboard, now)
    return true
  }

  companion object {
    fun startService(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, CompanionService::class.java))
    }
  }
}
