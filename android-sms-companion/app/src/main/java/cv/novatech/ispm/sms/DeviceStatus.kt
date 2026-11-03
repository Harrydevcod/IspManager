package cv.novatech.ispm.sms

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the phone says about itself on `GET /status`, so the desktop can show
 * "bateria 82 % · sinal 3/4 · v0.3.0". Nothing here needs a runtime permission.
 */
data class DeviceStatus(
  val appVersion: String?,
  val battery: Int?,
  val charging: Boolean?,
  val signalLevel: Int?,
  val simOperators: List<String>,
  val pending: Int,
  val uptimeSec: Long
) {
  fun toJson(): JSONObject = JSONObject()
    .put("appVersion", appVersion ?: JSONObject.NULL)
    .put("battery", battery ?: JSONObject.NULL)
    .put("charging", charging ?: JSONObject.NULL)
    .put("signalLevel", signalLevel ?: JSONObject.NULL)
    .put("simOperators", JSONArray(simOperators))
    .put("pending", pending)
    .put("uptimeSec", uptimeSec)

  companion object {
    // No static Android calls here: this class is also loaded by JVM unit tests.
    fun read(context: Context, pending: Int): DeviceStatus {
      val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
      val telephony = context.getSystemService(TelephonyManager::class.java)
      val signal = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        runCatching { telephony?.signalStrength?.level }.getOrNull()
      } else null
      val operator = runCatching { telephony?.networkOperatorName }.getOrNull()?.takeIf { it.isNotBlank() }
      val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull()
      return DeviceStatus(
        appVersion = version,
        battery = if (level >= 0 && scale > 0) level * 100 / scale else null,
        charging = batteryIntent?.let { plugged != 0 },
        signalLevel = signal,
        simOperators = listOfNotNull(operator),
        pending = pending,
        uptimeSec = (SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()) / 1000
      )
    }
  }
}
