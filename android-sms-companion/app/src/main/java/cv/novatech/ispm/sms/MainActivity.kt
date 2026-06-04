package cv.novatech.ispm.sms

import android.Manifest
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
  private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
  private lateinit var pairingStore: PairingStore
  private lateinit var requestStore: SmsRequestStore
  private var server: CompanionServer? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    pairingStore = PairingStore(this)
    requestStore = SmsRequestStore(this)
    handlePairingIntent(intent)

    server = CompanionServer(pairingStore, requestStore).also { it.start() }

    setContent {
      var requests by remember { mutableStateOf(requestStore.list()) }
      fun refresh() { requests = requestStore.list() }

      MaterialTheme {
        Column(modifier = Modifier.padding(24.dp)) {
          Text("ISPM SMS Companion", style = MaterialTheme.typography.titleLarge)
          Text(if (pairingStore.isPaired()) "Pareado: ${pairingStore.deviceName()}" else "Nao pareado")
          Button(onClick = { permissionLauncher.launch(Manifest.permission.SEND_SMS) }) {
            Text("Permitir envio de SMS")
          }
          Button(onClick = { refresh() }) { Text("Atualizar") }

          LazyColumn {
            items(requests.filter { it.status == "pending_approval" }) { item ->
              Text("${item.toPhone} — ${item.body}")
              Button(onClick = {
                try {
                  SmsSender.send(this@MainActivity, item.toPhone, item.body)
                  requestStore.updateStatus(item.id, "sent", null)
                } catch (e: Exception) {
                  requestStore.updateStatus(item.id, "failed", e.message ?: "Falha no envio SMS")
                }
                refresh()
              }) { Text("Aprovar e enviar") }
              Button(onClick = {
                requestStore.updateStatus(item.id, "rejected", "Rejeitado no Android")
                refresh()
              }) { Text("Rejeitar") }
            }
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handlePairingIntent(intent)
  }

  private fun handlePairingIntent(intent: Intent?) {
    val data = intent?.data ?: return
    if (data.scheme != "ispm-sms" || data.host != "pair") return
    val secret = data.getQueryParameter("secret") ?: return
    val device = data.getQueryParameter("device") ?: "ISPM Desktop"
    pairingStore.save(secret, device)
  }

  override fun onDestroy() {
    server?.stop()
    super.onDestroy()
  }
}
