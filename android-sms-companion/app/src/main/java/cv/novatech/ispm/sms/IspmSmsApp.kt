package cv.novatech.ispm.sms

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import androidx.core.content.ContextCompat
import cv.novatech.ispm.sms.state.CompanionStateHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Process-wide owner of the stores and the state holder. The HTTP server is
 * started by [CompanionService] so it outlives any Activity.
 */
class IspmSmsApp : Application() {
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  lateinit var pairingStore: PairingStore private set
  lateinit var requestStore: SmsRequestStore private set
  lateinit var settingsStore: SettingsStore private set
  lateinit var holder: CompanionStateHolder private set

  override fun onCreate() {
    super.onCreate()
    pairingStore = PairingStore(this)
    requestStore = SmsRequestStore(this)
    settingsStore = SettingsStore(this)
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

    // Re-read the LAN address whenever the default network changes (Wi-Fi swap, DHCP renew).
    getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = holder.refresh()
      override fun onLost(network: Network) = holder.refresh()
    })
    holder.refresh()
  }

  companion object {
    fun startService(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, CompanionService::class.java))
    }
  }
}
