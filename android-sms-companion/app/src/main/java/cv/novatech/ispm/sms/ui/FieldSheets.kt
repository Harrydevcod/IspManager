package cv.novatech.ispm.sms.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.events.FieldPhotos
import cv.novatech.ispm.sms.ui.components.ButtonVariant
import cv.novatech.ispm.sms.ui.components.IspmButton
import cv.novatech.ispm.sms.ui.components.SegmentedControl
import cv.novatech.ispm.sms.ui.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

private const val MAX_PHOTOS = 3

/**
 * Concluir uma OS no terreno: notas obrigatórias, até 3 fotos e, se o técnico
 * quiser, a posição. Fica na fila do telemóvel até o PC a ir buscar.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompleteOrderSheet(
  order: Dashboard.WorkOrder,
  onDismiss: () -> Unit,
  onSubmit: (notes: String, photos: List<ByteArray>, location: Pair<Double, Double>?) -> Unit
) {
  val context = LocalContext.current
  var notes by remember { mutableStateOf("") }
  val photos = remember { mutableStateListOf<ByteArray>() }
  var withLocation by remember { mutableStateOf(false) }
  var pendingUri by remember { mutableStateOf<Uri?>(null) }
  var photoError by remember { mutableStateOf(false) }

  val scope = rememberCoroutineScope()
  var compressing by remember { mutableStateOf(false) }
  val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
    val uri = pendingUri ?: return@rememberLauncherForActivityResult
    pendingUri = null
    scope.launch {
      compressing = true
      // Decoding a 12 MP photo takes a moment: off the main thread.
      val bytes = if (taken) withContext(Dispatchers.IO) { FieldPhotos.compress(context, uri) } else null
      withContext(Dispatchers.IO) { runCatching { context.contentResolver.delete(uri, null, null) } }
      if (bytes != null) photos.add(bytes)
      photoError = taken && bytes == null
      compressing = false
    }
  }
  val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    withLocation = granted
  }

  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("Concluir OS", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
      Text(order.title + (order.clientName?.let { " · $it" } ?: ""), color = TextSecondary, style = MaterialTheme.typography.bodySmall)
      OutlinedTextField(
        value = notes, onValueChange = { notes = it.take(2000) },
        label = { Text("O que foi feito") }, minLines = 3, modifier = Modifier.fillMaxWidth()
      )
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Fotos · ${photos.size}/$MAX_PHOTOS", color = TextSecondary, modifier = Modifier.weight(1f))
        IspmButton(
          if (compressing) "A preparar…" else "Tirar foto",
          onClick = {
            val uri = photoUri(context)
            pendingUri = uri
            camera.launch(uri)
          },
          enabled = photos.size < MAX_PHOTOS && !compressing
        )
      }
      if (photoError) Text("A foto não ficou guardada. Tente de novo.", color = Warn, style = MaterialTheme.typography.bodySmall)
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text("Guardar a posição", color = TextPrimary)
          Text("Para o PC mostrar no mapa onde a OS foi concluída.", color = TextMuted, style = MaterialTheme.typography.bodySmall)
        }
        Switch(checked = withLocation, onCheckedChange = { on ->
          if (on && !hasLocationPermission(context)) locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION) else withLocation = on
        })
      }
      IspmButton(
        "Concluir e enviar ao PC",
        onClick = { onSubmit(notes.trim(), photos.toList(), if (withLocation) lastLocation(context) else null) },
        modifier = Modifier.fillMaxWidth(), variant = ButtonVariant.PRIMARY,
        enabled = notes.isNotBlank() && !compressing
      )
    }
  }
}

/**
 * Recebi em mão: fica como proposta no PC. Nada entra na caixa até o operador
 * confirmar lá, por isso aqui não há recibo nem número.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiptSheet(
  debtor: Dashboard.Debtor,
  onDismiss: () -> Unit,
  onSubmit: (amountCve: Long, method: String, note: String) -> Unit
) {
  var amount by remember { mutableStateOf(debtor.amountCve.toString()) }
  var method by remember { mutableStateOf("numerario") }
  var note by remember { mutableStateOf("") }
  val value = amount.filter { it.isDigit() }.toLongOrNull() ?: 0L

  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text("Recebi em mão", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
      Text("${debtor.clientName} · deve ${DashboardRules.formatCve(debtor.amountCve)}", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
      OutlinedTextField(
        value = amount, onValueChange = { amount = it.filter(Char::isDigit).take(9) },
        label = { Text("Valor recebido (CVE)") }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth()
      )
      SegmentedControl(listOf("numerario", "transferencia"), method, { if (it == "numerario") "Numerário" else "Transferência" }, { method = it })
      OutlinedTextField(
        value = note, onValueChange = { note = it.take(500) },
        label = { Text("Nota (opcional)") }, singleLine = true, modifier = Modifier.fillMaxWidth()
      )
      Text("Fica à espera de confirmação no PC: só aí entra na caixa.", color = TextMuted, style = MaterialTheme.typography.bodySmall)
      IspmButton(
        "Enviar ${DashboardRules.formatCve(value)} ao PC", onClick = { onSubmit(value, method, note.trim()) },
        modifier = Modifier.fillMaxWidth(), variant = ButtonVariant.PRIMARY, enabled = value > 0
      )
    }
  }
}

private fun photoUri(context: Context): Uri {
  val dir = File(context.cacheDir, "field-photos").apply { mkdirs() }
  val file = File(dir, "${UUID.randomUUID()}.jpg")
  return FileProvider.getUriForFile(context, "${context.packageName}.photos", file)
}

private fun hasLocationPermission(context: Context) =
  ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
    ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

// ponytail: the freshest last-known fix, no live GPS request; ask for a fresh fix (getCurrentLocation) if techs report stale pins.
@SuppressLint("MissingPermission")
private fun lastLocation(context: Context): Pair<Double, Double>? {
  if (!hasLocationPermission(context)) return null
  val manager = context.getSystemService(LocationManager::class.java) ?: return null
  return manager.getProviders(true)
    .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
    .maxByOrNull { it.time }
    ?.let { it.latitude to it.longitude }
}
