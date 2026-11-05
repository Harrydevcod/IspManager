package cv.novatech.ispm.sms.state

import cv.novatech.ispm.sms.SmsRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BuildUiStateTest {
  private fun req(id: String, status: String, name: String? = null) =
    SmsRequest(id = id, toPhone = "+2389912233", body = "ola", eventType = "receipt_confirmed", status = status, error = null, clientName = name)

  private val pairing = PairingSnapshot(paired = true, deviceName = "Loja", listenAddress = "192.168.1.50:8765")

  @Test fun partitionsPendingAndHistory() {
    val s = buildUiState(pairing, serverRunning = true, smsPermissionGranted = true,
      requests = listOf(req("1", "pending_approval"), req("2", "sent"), req("3", "rejected")), sendingIds = emptySet())
    assertEquals(listOf("1"), s.pending.map { it.id })
    assertEquals(setOf("2", "3"), s.history.map { it.id }.toSet())
  }

  @Test fun historyIsNewestFirstAndCapped() {
    val sent = (1..60).map { req(it.toString(), "sent") }
    val s = buildUiState(pairing, true, true, sent, emptySet())
    assertEquals(HISTORY_LIMIT, s.history.size)
    assertEquals("60", s.history.first().id) // newest first
  }

  @Test fun clientNameCarriedWithPhoneFallback() {
    val s = buildUiState(pairing, true, true, listOf(req("1", "pending_approval", "Ana Lopes"), req("2", "pending_approval", null)), emptySet())
    assertEquals("Ana Lopes", s.pending.first { it.id == "1" }.clientName)
    assertNull(s.pending.first { it.id == "2" }.clientName)
  }

  @Test fun sendingOverlayMarksRequest() {
    val s = buildUiState(pairing, true, true, listOf(req("1", "pending_approval")), sendingIds = setOf("1"))
    assertEquals(true, s.pending.first().sending)
  }

  @Test fun desktopLinkFollowsTheLastSignedRequest() {
    val now = 10 * 60_000L
    fun link(seen: Long?, rejected: Long?) = desktopLink(CompanionUiState(lastDesktopAt = seen, lastRejectedAt = rejected), now)
    assertEquals(DesktopLink.WAITING, link(null, null))
    assertEquals(DesktopLink.LINKED, link(now - 60_000, null))
    assertEquals(DesktopLink.WAITING, link(now - LINK_WINDOW_MS - 1, null)) // silent too long
    assertEquals(DesktopLink.MISMATCH, link(now - 60_000, now - 1_000)) // rejected after the last good one
    assertEquals(DesktopLink.LINKED, link(now - 1_000, now - 60_000)) // good one came after
    assertEquals(DesktopLink.WAITING, link(null, now - LINK_WINDOW_MS - 1)) // old rejection fades
  }
}
