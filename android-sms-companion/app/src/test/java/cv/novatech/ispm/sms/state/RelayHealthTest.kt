package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayHealthTest {
  private val now = 1_700_000_000_000L
  private val falha = RelayPoll.Failed("Sem resposta do relé")

  @Test fun `a primeira falha marca a hora e cala-se`() {
    val (state, event) = RelayHealthRules.onResult(RelayHealth(), falha, now)
    assertEquals(now, state.failingSince)
    assertEquals("Sem resposta do relé", state.lastError)
    assertNull(event)
  }

  @Test fun `passados cinco minutos anuncia a queda, e so uma vez`() {
    val (meio, nada) = RelayHealthRules.onResult(RelayHealth(), falha, now)
    assertNull(nada)

    val (caiu, evento) = RelayHealthRules.onResult(meio, falha, now + RelayHealthRules.DOWN_AFTER_MS)
    assertEquals(RelayEvent.Down, evento)
    assertEquals(now, caiu.failingSince)

    val (ainda, repetido) = RelayHealthRules.onResult(caiu, falha, now + 10 * 60_000L)
    assertNull(repetido)
    assertEquals(now, ainda.failingSince)
  }

  @Test fun `voltar depois de uma queda anunciada diz que voltou`() {
    val (caiu, _) = RelayHealthRules.onResult(
      RelayHealthRules.onResult(RelayHealth(), falha, now).first, falha, now + RelayHealthRules.DOWN_AFTER_MS
    )
    val (ok, evento) = RelayHealthRules.onResult(caiu, RelayPoll.Ok(0), now + 10 * 60_000L)
    assertEquals(RelayEvent.Up, evento)
    assertNull(ok.failingSince)
    assertNull(ok.lastError)
    assertEquals(now + 10 * 60_000L, ok.lastOkAt)
  }

  @Test fun `voltar sem ter chegado a anunciar nao diz nada`() {
    val (meio, _) = RelayHealthRules.onResult(RelayHealth(), falha, now)
    val (ok, evento) = RelayHealthRules.onResult(meio, RelayPoll.Ok(0), now + 60_000L)
    assertNull(evento)
    assertNull(ok.failingSince)
  }

  @Test fun `sem rele configurado o estado fica limpo`() {
    val sujo = RelayHealth(failingSince = now, lastError = "x", downNotified = true)
    val (state, evento) = RelayHealthRules.onResult(sujo, RelayPoll.Off, now)
    assertEquals(RelayHealth(), state)
    assertNull(evento)
  }

  @Test fun `a rede local de volta limpa o estado sem anunciar`() {
    val caiu = RelayHealth(failingSince = now, lastOkAt = now - 1000, lastError = "x", downNotified = true)
    val limpo = RelayHealthRules.onLanBack(caiu)
    assertNull(limpo.failingSince)
    assertEquals(false, limpo.downNotified)
    assertEquals(now - 1000, limpo.lastOkAt)
  }

  @Test fun `com o rele em baixo pergunta-se menos vezes`() {
    assertEquals(RelayHealthRules.POLL_MS, RelayHealthRules.pollIntervalMs(RelayHealth()))
    assertEquals(RelayHealthRules.BACKOFF_POLL_MS, RelayHealthRules.pollIntervalMs(RelayHealth(failingSince = now)))
  }
}
