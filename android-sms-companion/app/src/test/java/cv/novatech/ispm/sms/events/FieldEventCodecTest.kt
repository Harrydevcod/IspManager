package cv.novatech.ispm.sms.events

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldEventCodecTest {
  private val done = FieldEvent("11111111-aaaa", FieldEvent.WORK_ORDER_DONE, 2_000L, """{"workOrderId":7,"notes":"ok"}""")
  private val cash = FieldEvent("22222222-bbbb", FieldEvent.RECEIPT_PROPOSAL, 1_000L, """{"clientCode":"CL-1","amountCve":2500,"method":"numerario"}""")

  @Test fun storageRoundTrip() {
    val back = FieldEventCodec.decode(FieldEventCodec.encode(listOf(done, cash)))
    assertEquals(listOf(done, cash).map { Triple(it.id, it.kind, it.at) }, back.map { Triple(it.id, it.kind, it.at) })
    // org.json on the JVM may reorder keys: compare the payloads as JSON, not as text.
    assertTrue(back[0].payload.similar(done.payload))
    assertTrue(back[1].payload.similar(cash.payload))
  }

  @Test fun brokenStorageIsAnEmptyQueueNotACrash() {
    assertTrue(FieldEventCodec.decode("not json").isEmpty())
  }

  @Test fun desktopGetsOldestFirstWithIsoDates() {
    val events = FieldEventCodec.forDesktop(listOf(done, cash)).getJSONArray("events")
    assertEquals("22222222-bbbb", events.getJSONObject(0).getString("id"))
    assertEquals("1970-01-01T00:00:01Z", events.getJSONObject(0).getString("at"))
    assertEquals(7, events.getJSONObject(1).getJSONObject("payload").getInt("workOrderId"))
  }

  @Test fun desktopPullIsCapped() {
    val many = (1..80).map { FieldEvent("evt-${it.toString().padStart(8, '0')}", FieldEvent.SMS_IN, it.toLong(), "{}") }
    assertEquals(FieldEventCodec.PULL_LIMIT, FieldEventCodec.forDesktop(many).getJSONArray("events").length())
  }

  @Test fun ackAcceptsOnlyRealIds() {
    val body = JSONObject().put("ids", org.json.JSONArray(listOf("11111111-aaaa", "../../etc/passwd", "x"))).toString()
    assertEquals(setOf("11111111-aaaa"), FieldEventCodec.ackIds(body))
    assertTrue(FieldEventCodec.ackIds("{}").isEmpty())
  }

  @Test fun photoSampleKeepsTheLongSideAtLeast1600() {
    assertEquals(1, FieldPhotos.sampleSize(1600, 1200))
    assertEquals(2, FieldPhotos.sampleSize(4000, 3000))
    assertEquals(2, FieldPhotos.sampleSize(3000, 4000))
    assertEquals(4, FieldPhotos.sampleSize(8000, 6000))
  }
}
