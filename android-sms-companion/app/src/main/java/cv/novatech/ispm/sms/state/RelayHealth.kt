package cv.novatech.ispm.sms.state

/**
 * Se o relé está a responder, e desde quando deixou de estar.
 *
 * Até aqui "não tinha nada para mim" e "não consegui falar com ele" davam o
 * mesmo resultado, e uma queda do relé passava em silêncio: o PC deixava de
 * chegar ao telemóvel e ninguém dava por isso.
 *
 * Regras puras, para correr na JVM: o `now` entra por parâmetro.
 */

/** O que uma volta ao relé deu. */
sealed interface RelayPoll {
  /** Correu bem; `ran` são os pedidos executados (0 = caixa vazia). */
  data class Ok(val ran: Int) : RelayPoll
  /** Não deu: sem rede, timeout, ou uma resposta que não é 200. */
  data class Failed(val reason: String) : RelayPoll
  /** Sem relé configurado — não é falha nenhuma. */
  object Off : RelayPoll
}

data class RelayHealth(
  val failingSince: Long? = null,
  val lastOkAt: Long? = null,
  val lastError: String? = null,
  /** Já se registou a queda desta vez: o aviso sai uma só vez por queda. */
  val downNotified: Boolean = false
)

/** O que há a anunciar depois de uma volta. */
enum class RelayEvent { Down, Up }

object RelayHealthRules {
  /** O relé tem de estar calado cinco minutos antes de valer um aviso. */
  const val DOWN_AFTER_MS = RELAY_DOWN_AFTER_MS

  /** Ritmo normal, e o recuo quando o relé está em baixo (não se gasta bateria contra uma parede). */
  const val POLL_MS = 15_000L
  const val BACKOFF_POLL_MS = 60_000L

  fun onResult(state: RelayHealth, poll: RelayPoll, now: Long): Pair<RelayHealth, RelayEvent?> = when (poll) {
    is RelayPoll.Off -> RelayHealth() to null

    is RelayPoll.Ok -> {
      val event = if (state.downNotified) RelayEvent.Up else null
      RelayHealth(failingSince = null, lastOkAt = now, lastError = null, downNotified = false) to event
    }

    is RelayPoll.Failed -> {
      val since = state.failingSince ?: now
      val announce = !state.downNotified && now - since >= DOWN_AFTER_MS
      RelayHealth(
        failingSince = since,
        lastOkAt = state.lastOkAt,
        lastError = poll.reason,
        downNotified = state.downNotified || announce
      ) to (if (announce) RelayEvent.Down else null)
    }
  }

  /**
   * A rede local voltou e o relé deixou de ser usado: o estado limpa-se sem
   * anunciar nada. O PC está a falar por aqui, o relé deixou de importar.
   */
  fun onLanBack(state: RelayHealth): RelayHealth =
    if (state.failingSince == null && !state.downNotified) state else RelayHealth(lastOkAt = state.lastOkAt)

  fun pollIntervalMs(state: RelayHealth): Long =
    if (state.failingSince == null) POLL_MS else BACKOFF_POLL_MS
}
