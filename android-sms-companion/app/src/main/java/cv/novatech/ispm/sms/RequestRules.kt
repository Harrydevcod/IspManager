package cv.novatech.ispm.sms

/**
 * Pure rules for the request lifecycle, kept free of Android types so they run
 * in JVM unit tests. The store and the receivers only apply these.
 *
 * Lifecycle: pending_approval → approved → sending → sent | failed, or rejected.
 */
object RequestRules {
  const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000
  const val INTERRUPTED = "Envio interrompido — verificar no telemóvel"
  private val FINAL = setOf("sent", "failed", "rejected")

  /** Drops final rows older than the retention window; open rows are always kept. */
  fun prune(rows: List<SmsRequest>, now: Long): List<SmsRequest> =
    rows.filter { it.status !in FINAL || now - (it.updatedAt ?: it.createdAt ?: now) < RETENTION_MS }

  /**
   * After a process restart: approved rows are re-armed (returned as ids), and
   * rows stuck in `sending` become failed. Never resend blindly — the SIM may
   * already have sent it, and a duplicate SMS costs the client's trust.
   */
  fun recover(rows: List<SmsRequest>, now: Long): Pair<List<SmsRequest>, List<String>> {
    val rearm = rows.filter { it.status == "approved" }.map { it.id }
    val fixed = rows.map {
      if (it.status == "sending") it.copy(status = "failed", error = INTERRUPTED, updatedAt = now) else it
    }
    return fixed to rearm
  }

  /**
   * The SENT broadcast for one part. A real part error always wins; a success on
   * the last part also overrides an INTERRUPTED mark (the process died between
   * the send call and this broadcast, but the network did accept it).
   * ponytail: assumes parts report in order, which is what the radio does.
   */
  fun onSentResult(row: SmsRequest, resultOk: Boolean, isLastPart: Boolean, resultCode: Int, now: Long): SmsRequest {
    if (!resultOk) return row.copy(status = "failed", error = sentErrorMessage(resultCode), updatedAt = now)
    if (!isLastPart) return row
    val realFailure = row.status == "failed" && row.error != INTERRUPTED
    if (realFailure || row.status == "rejected") return row
    return row.copy(status = "sent", error = null, sentAt = now, updatedAt = now)
  }

  fun onDelivered(row: SmsRequest, now: Long): SmsRequest =
    if (row.deliveredAt != null) row else row.copy(deliveredAt = now, updatedAt = now)

  /** What the desktop sees: it only knows approved/sent/failed/rejected. */
  fun desktopStatus(status: String): String = if (status == "sending") "approved" else status

  // SmsManager.RESULT_ERROR_* values, inlined so this stays JVM-testable.
  fun sentErrorMessage(code: Int): String = when (code) {
    1 -> "Falha genérica da rede"
    2 -> "Rádio desligado (modo avião?)"
    3 -> "Mensagem inválida (PDU nulo)"
    4 -> "Sem serviço de rede"
    5 -> "Limite de envio de SMS atingido"
    else -> "Falha no envio (código $code)"
  }
}
