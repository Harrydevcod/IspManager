package cv.novatech.ispm.sms

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cv.novatech.ispm.sms.state.DeviceSnapshot
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.SimOption
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.CompanionApp
import cv.novatech.ispm.sms.ui.LockScreen
import cv.novatech.ispm.sms.ui.theme.IspmTheme

/** UI only: the server and the approval pipeline live in [IspmSmsApp] + [CompanionService]. */
// FragmentActivity (a ComponentActivity) because BiometricPrompt needs one.
class MainActivity : FragmentActivity() {
  private val app get() = application as IspmSmsApp
  private var locked by mutableStateOf(true)

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
    // Decided before the first frame, so the lock screen never prompts when the lock is off.
    locked = LockRules.mustLock(app.settingsStore.lockEnabled(), deviceSecure(), app.unlocked, app.backgroundAt, System.currentTimeMillis())

    setContent {
      IspmTheme {
        val state by app.holder.state.collectAsStateWithLifecycle()
        if (locked) {
          LockScreen(onUnlock = ::authenticate)
          return@IspmTheme
        }
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
          onReject = { app.holder.reject(it) },
          onForgetPairing = { app.holder.unpair() },
          onOpen = ::openExternal,
          onLockEnabledChange = { enabled ->
            app.settingsStore.setLockEnabled(enabled)
            refreshDevice()
            applySecureFlag()
          }
        )
      }
    }
  }

  override fun onStart() {
    super.onStart()
    val mustLock = LockRules.mustLock(app.settingsStore.lockEnabled(), deviceSecure(), app.unlocked, app.backgroundAt, System.currentTimeMillis())
    if (mustLock) app.unlocked = false
    locked = mustLock
    applySecureFlag()
  }

  override fun onStop() {
    super.onStop()
    // A rotation is not leaving the app.
    if (!isChangingConfigurations) app.backgroundAt = System.currentTimeMillis()
  }

  private fun authenticate() {
    val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        app.unlocked = true
        app.backgroundAt = null
        locked = false
      }
    })
    // WEAK | DEVICE_CREDENTIAL works from API 26 up and falls back to the phone's own PIN.
    prompt.authenticate(
      BiometricPrompt.PromptInfo.Builder()
        .setTitle("Desbloquear o ISPM SMS")
        .setSubtitle("Impressão digital ou PIN do telemóvel")
        .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
        .build()
    )
  }

  private fun deviceSecure() =
    BiometricManager.from(this).canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS

  /** With the lock on, client data stays out of the recents view and screenshots. */
  private fun applySecureFlag() {
    if (app.settingsStore.lockEnabled() && deviceSecure()) window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }

  /** tel: dials (never calls by itself), smsto: opens the SMS app, the rest is viewed. */
  private fun openExternal(uri: String) {
    val parsed = Uri.parse(uri)
    val action = when (parsed.scheme) {
      "tel" -> Intent.ACTION_DIAL
      "smsto" -> Intent.ACTION_SENDTO
      else -> Intent.ACTION_VIEW
    }
    // Most SMS apps read the prefilled text from the "sms_body" extra, not from ?body=.
    // smsto: is an opaque URI (getQueryParameter throws), so the body is split off by hand.
    val body = if (parsed.scheme == "smsto" && "?body=" in uri) Uri.decode(uri.substringAfter("?body=")) else null
    val intent = if (body != null) {
      Intent(action, Uri.parse(uri.substringBefore("?body="))).putExtra("sms_body", body)
    } else {
      Intent(action, parsed)
    }
    try {
      startActivity(intent)
    } catch (_: ActivityNotFoundException) {
      toast(if (parsed.scheme == "geo") "Nenhuma app de mapas instalada" else "Nenhuma app para abrir isto")
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
        selectedSim = app.settingsStore.subscriptionId(),
        lockEnabled = app.settingsStore.lockEnabled(),
        deviceSecure = deviceSecure()
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
