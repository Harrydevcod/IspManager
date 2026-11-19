package cv.novatech.ispm.sms

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsRequestCodecTest {
  @Test fun readsRowsWrittenByVersion010() {
    val legacy = """[{"id":"1","toPhone":"+2389912233","body":"ola","eventType":"test","status":"sent","error":"","clientName":""}]"""
    val row = SmsRequestStore.decode(legacy).single()
    assertEquals("sent", row.status)
    assertNull(row.error)
    assertNull(row.clientName)
    assertNull(row.createdAt)
    assertNull(row.deliveredAt)
  }

  @Test fun linhaSemReenviosLeSeComoZero() {
    val row012 = """[{"id":"1","toPhone":"+2389912233","body":"ola","eventType":"test","status":"failed","error":"Sem rede"}]"""
    assertEquals(0, SmsRequestStore.decode(row012).single().attempts)
  }

  @Test fun reenviosFazemORoundTrip() {
    val r = SmsRequest("1", "+2389912233", "ola", "test", "failed", "Sem rede", attempts = 2)
    assertEquals(2, SmsRequestStore.decode(JSONArray().put(SmsRequestStore.encode(r)).toString()).single().attempts)
  }

  @Test fun roundTripsTimestamps() {
    val r = SmsRequest("1", "+2389912233", "ola", "test", "sent", null, "Ana", createdAt = 1, updatedAt = 2, approvedAt = 3, sentAt = 4, deliveredAt = 5)
    val back = SmsRequestStore.decode(JSONArray().put(SmsRequestStore.encode(r)).toString()).single()
    assertEquals(r, back)
  }
}
