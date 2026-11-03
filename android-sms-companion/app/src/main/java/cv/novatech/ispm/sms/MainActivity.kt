package cv.novatech.ispm.sms

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cv.novatech.ispm.sms.state.DeviceSnapshot
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.SimOption
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.CompanionApp
import cv.novatech.ispm.sms.ui.theme.IspmTheme

/** UI only: the server and the approval pipeline live in [IspmSmsApp] + [CompanionService]. */
class MainActivity : ComponentActivity() {
  private val app get() = application as IspmSmsApp

  private val permissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      app.holder.setPermissionGranted(granted)
    }

  private val notificationPermissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort: alerts simply stay off if denied */ }

  private val phoneStatePermissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshDevice() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handlePairingIntent(intent)
    requestNotificationPermission()
    IspmSmsApp.startService(this)
    app.holder.setPermissionGranted(hasPermission(Manifest.permission.SEND_SMS))

    setContent {
      IspmTheme {
        val state by app.holder.state.collectAsStateWithLifecycle()
        CompanionApp(
          state = state,
          onPaired = { app.holder.pair(it) },
          onInvalidPairing = { toast("Código de pareamento inválido") },
          onRequestPermission = { permissionLauncher.launch(Manifest.permission.SEND_SMS) },
          onRequestBatteryExemption = ::requestBatteryExemption,
          onRequestPhoneState = { phoneStatePermissionLauncher.launch(Manifest.permission.READ_PHONE_STATE) },
          onChooseSim = { id ->
            app.settingsStore.setSubscriptionId(id)
            refreshDevice()
          },
          onApprove = { id ->
            if (state.smsPermissionGranted) app.holder.approve(id)
            else permissionLauncher.launch(Manifest.permission.SEND_SMS)
          },
          onApproveAll = {
            if (state.smsPermissionGranted) app.holder.approveAll()
            else permissionLauncher.launch(Manifest.permission.SEND_SMS)
          },
          onUndo = { app.holder.undoApprove(it) },
          onReject = { app.holder.reject(it) }
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    app.holder.setPermissionGranted(hasPermission(Manifest.permission.SEND_SMS))
    refreshDevice()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handlePairingIntent(intent)
  }

  private fun handlePairingIntent(intent: Intent?) {
    val data = intent?.dataString ?: return
    val info: PairingInfo = parsePairingPayload(data) ?: return
    app.holder.pair(info)
  }

  private fun refreshDevice() {
    val power = getSystemService(PowerManager::class.java)
    val subs = getSystemService(SubscriptionManager::class.java)
    app.holder.setDevice(
      DeviceSnapshot(
        batteryExempt = power?.isIgnoringBatteryOptimizations(packageName) ?: true,
        dualSimCapable = (subs?.activeSubscriptionInfoCountMax ?: 1) >= 2,
        sims = activeSims(subs),
        selectedSim = app.settingsStore.subscriptionId()
      )
    )
  }

  @SuppressLint("MissingPermission") // guarded by hasPermission below
  private fun activeSims(subs: SubscriptionManager?): List<SimOption> {
    if (subs == null || !hasPermission(Manifest.permission.READ_PHONE_STATE)) return emptyList()
    return runCatching {
      subs.activeSubscriptionInfoList.orEmpty().map {
        SimOption(it.subscriptionId, "SIM ${it.simSlotIndex + 1} · ${it.displayName ?: it.carrierName ?: "?"}")
      }
    }.getOrDefault(emptyList())
  }

  @SuppressLint("BatteryLife") // sideloaded tool; exemption is the whole point of the banner
  private fun requestBatteryExemption() {
    runCatching {
      startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }.onFailure {
      startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
  }

  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (!hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
