package cv.novatech.ispm.sms

import android.annotation.SuppressLint
import android.app.Application
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import cv.novatech.ispm.sms.send.SendBudget
import cv.novatech.ispm.sms.send.SendLogStore
import cv.novatech.ispm.sms.send.SendScheduler
import org.json.JSONArray
import org.json.JSONObject
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
import cv.novatech.ispm.sms.events.EventStore
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
  lateinit var eventStore: EventStore private set
  lateinit var sendLog: SendLogStore private set
  private lateinit var scheduler: SendScheduler
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
    eventStore = EventStore(this)
    sendLog = SendLogStore(this)
    scheduler = SendScheduler(
      store = sendLog,
      sims = ::simsForSending,
      limits = { settingsStore.simLimits() },
      partsOf = { body -> runCatching { smsManager().divideMessage(body).size }.getOrDefault(1) },
      onWait = { id, until -> holder.setWaiting(id, until) }
    )
    holder = CompanionStateHolder(
      pairingStore = pairingStore,
      requestStore = requestStore,
      scope = scope,
      send = { req, sim -> SmsSender.send(this, req, sim) },
      dispatch = { req, go -> scheduler.dispatch(req.id, req.body, go) }
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

  @Suppress("DEPRECATION")
  private fun smsManager(): SmsManager = getSystemService(SmsManager::class.java) ?: SmsManager.getDefault()

  /** The SIMs a send may use: all active ones when alternating, else the chosen one (-1 = default). */
  @SuppressLint("MissingPermission") // SecurityException without READ_PHONE_STATE falls back to the default SIM
  fun simsForSending(): List<Int> {
    if (!settingsStore.rotateSims()) return listOf(settingsStore.subscriptionId() ?: SendBudget.DEFAULT_SIM)
    val ids = runCatching { getSystemService(SubscriptionManager::class.java)?.activeSubscriptionInfoList?.map { it.subscriptionId } }.getOrNull()
    return ids?.takeIf { it.isNotEmpty() } ?: listOf(SendBudget.DEFAULT_SIM)
  }

  /** `GET /status`: what the phone tells the desktop about itself, with each SIM's sending budget. */
  fun deviceStatusJson(): JSONObject {
    val now = System.currentTimeMillis()
    val limits = settingsStore.simLimits()
    val log = sendLog.log(now)
    val paused = sendLog.paused(now)
    val budgets = JSONArray().apply {
      simsForSending().forEach { sim ->
        val u = SendBudget.usage(log, sim, now, paused[sim])
        put(JSONObject().put("sim", sim).put("usedHour", u.usedHour).put("perHour", limits.perHour)
          .put("usedDay", u.usedDay).put("perDay", limits.perDay)
          .put("pausedUntil", u.pausedUntil?.let { java.time.Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL))
      }
    }
    return DeviceStatus.read(this, holder.state.value.pending.size).toJson()
      .put("simBudgets", budgets)
      .put("syncRequested", holder.syncRequested())
  }

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
