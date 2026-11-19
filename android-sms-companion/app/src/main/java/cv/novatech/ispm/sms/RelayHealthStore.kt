package cv.novatech.ispm.sms

import android.content.Context
import cv.novatech.ispm.sms.state.RelayHealth

/**
 * O estado de saúde do relé, guardado para o aviso sobreviver a um reinício do
 * serviço: sem isto, o relógio dos cinco minutos recomeçava do zero sempre que
 * o Android reciclasse o processo, e a queda nunca chegaria a ser anunciada.
 */
class RelayHealthStore(context: Context) {
  private val prefs = context.getSharedPreferences("relay_health", Context.MODE_PRIVATE)

  fun read(): RelayHealth = RelayHealth(
    failingSince = prefs.getLong(SINCE, 0L).takeIf { it > 0L },
    lastOkAt = prefs.getLong(LAST_OK, 0L).takeIf { it > 0L },
    lastError = prefs.getString(ERROR, null)?.ifBlank { null },
    downNotified = prefs.getBoolean(NOTIFIED, false)
  )

  fun write(health: RelayHealth) {
    prefs.edit()
      .putLong(SINCE, health.failingSince ?: 0L)
      .putLong(LAST_OK, health.lastOkAt ?: 0L)
      .putString(ERROR, health.lastError ?: "")
      .putBoolean(NOTIFIED, health.downNotified)
      .apply()
  }

  private companion object {
    const val SINCE = "failingSince"
    const val LAST_OK = "lastOkAt"
    const val ERROR = "lastError"
    const val NOTIFIED = "downNotified"
  }
}
