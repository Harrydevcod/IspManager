package cv.novatech.ispm.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RequestRulesTest {
  private val day = 24L * 60 * 60 * 1000
  private fun req(id: String, status: String, updatedAt: Long? = null, error: String? = null) =
    SmsRequest(id, "+2389912233", "ola", "receipt_confirmed", status, error, updatedAt = updatedAt)

  @Test fun pruneDropsOldFinalRowsAndKeepsOpenOnes() {
    val now = 100 * day
    val rows = listOf(
      req("old-sent", "sent", now - 31 * day),
      req("new-sent", "sent", now - 2 * day),
      req("old-pending", "pending_approval", now - 90 * day),
      req("legacy", "failed", null) // 0.1.0 row without timestamps: kept, not guessed old
    )
    assertEquals(listOf("new-sent", "old-pending", "legacy"), RequestRules.prune(rows, now).map { it.id })
  }

  @Test fun recoverRearmsApprovedAndFailsOrphanedSending() {
    val (fixed, rearm) = RequestRules.recover(listOf(req("a", "approved"), req("s", "sending"), req("p", "pending_approval")), 5L)
    assertEquals(listOf("a"), rearm)
    val s = fixed.first { it.id == "s" }
    assertEquals("failed", s.status)
    assertEquals(RequestRules.INTERRUPTED, s.error)
    assertEquals("pending_approval", fixed.first { it.id == "p" }.status)
  }

  @Test fun sentOnlyAfterLastPart() {
    val row = req("1", "sending")
    assertEquals("sending", RequestRules.onSentResult(row, resultOk = true, isLastPart = false, resultCode = -1, now = 1).status)
    val done = RequestRules.onSentResult(row, resultOk = true, isLastPart = true, resultCode = -1, now = 9)
    assertEquals("sent", done.status)
    assertEquals(9L, done.sentAt)
  }

  @Test fun partFailureWinsOverLaterSuccess() {
    val failed = RequestRules.onSentResult(req("1", "sending"), resultOk = false, isLastPart = false, resultCode = 4, now = 1)
    assertEquals("failed", failed.status)
    assertEquals("Sem serviço de rede", failed.error)
    assertEquals("failed", RequestRules.onSentResult(failed, true, true, -1, 2).status)
  }

  @Test fun lateSuccessOverridesInterruptedMark() {
    val interrupted = req("1", "failed", error = RequestRules.INTERRUPTED)
    val r = RequestRules.onSentResult(interrupted, true, true, -1, 3)
    assertEquals("sent", r.status)
    assertNull(r.error)
  }

  @Test fun deliveredRecordedOnce() {
    val first = RequestRules.onDelivered(req("1", "sent"), 10)
    assertEquals(10L, first.deliveredAt)
    assertEquals(10L, RequestRules.onDelivered(first, 20).deliveredAt)
  }

  @Test fun desktopNeverSeesSending() {
    assertEquals("approved", RequestRules.desktopStatus("sending"))
    assertEquals("sent", RequestRules.desktopStatus("sent"))
  }

  @Test fun unknownErrorCodeKeepsTheCode() {
    assertEquals("Falha no envio (código 42)", RequestRules.sentErrorMessage(42))
    assertEquals("Rádio desligado (modo avião?)", RequestRules.sentErrorMessage(2))
  }
}
