package cv.novatech.ispm.sms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import cv.novatech.ispm.sms.state.CompanionStateHolder
import cv.novatech.ispm.sms.state.PairingInfo
import cv.novatech.ispm.sms.state.parsePairingPayload
import cv.novatech.ispm.sms.ui.CompanionApp
import cv.novatech.ispm.sms.ui.theme.IspmTheme

class MainActivity : ComponentActivity() {
  private lateinit var pairingStore: PairingStore
  private lateinit var requestStore: SmsRequestStore
  private lateinit var holder: CompanionStateHolder
  private var server: CompanionServer? = null

  private val permissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      holder.setPermissionGranted(granted)
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    pairingStore = PairingStore(this)
    requestStore = SmsRequestStore(this)
    holder = CompanionStateHolder(
      pairingStore = pairingStore,
      requestStore = requestStore,
      scope = lifecycleScope,
      send = { req -> SmsSender.send(this, req.toPhone, req.body) }
    )

    handlePairingIntent(intent)

    server = CompanionServer(pairingStore, requestStore, onRequestsChanged = { runOnUiThread { holder.refresh() } })
      .also { runCatching { it.start() } }
    holder.setServerRunning(server != null)
    holder.setPermissionGranted(
      ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
    )

    setContent {
      IspmTheme {
        val state by holder.state.collectAsStateWithLifecycle()
        CompanionApp(
          state = state,
          onPaired = { holder.pair(it) },
          onInvalidPairing = { toast("Código de pareamento inválido") },
          onRequestPermission = { permissionLauncher.launch(Manifest.permission.SEND_SMS) },
          onApprove = { id ->
            if (state.smsPermissionGranted) holder.approve(id)
            else permissionLauncher.launch(Manifest.permission.SEND_SMS)
          },
          onUndo = { holder.undoApprove(it) },
          onReject = { holder.reject(it) }
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    if (::holder.isInitialized) holder.refresh()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handlePairingIntent(intent)
  }

  private fun handlePairingIntent(intent: Intent?) {
    val data = intent?.dataString ?: return
    val info: PairingInfo = parsePairingPayload(data) ?: return
    if (::holder.isInitialized) holder.pair(info) else pairingStore.save(info.secret, info.deviceName)
  }

  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  override fun onDestroy() {
    server?.stop()
    super.onDestroy()
  }
}
