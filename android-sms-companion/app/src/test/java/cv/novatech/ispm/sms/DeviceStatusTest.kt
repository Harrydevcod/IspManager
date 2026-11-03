package cv.novatech.ispm.sms

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStatusTest {
  // Field names are the contract read by parseDeviceStatus in src/backend/lib/companion-sync.ts.
  @Test fun serializesWhatTheDesktopReads() {
    val json = DeviceStatus("0.3.0", 82, true, 3, listOf("CVMóvel"), pending = 2, uptimeSec = 120).toJson()
    assertEquals("0.3.0", json.getString("appVersion"))
    assertEquals(82, json.getInt("battery"))
    assertEquals(true, json.getBoolean("charging"))
    assertEquals(3, json.getInt("signalLevel"))
    assertEquals("CVMóvel", json.getJSONArray("simOperators").getString(0))
    assertEquals(2, json.getInt("pending"))
    assertEquals(120L, json.getLong("uptimeSec"))
  }

  @Test fun unknownsAreNullNotMissing() {
    val json = DeviceStatus(null, null, null, null, emptyList(), 0, 0).toJson()
    listOf("appVersion", "battery", "charging", "signalLevel").forEach { assertTrue(json.isNull(it)) }
    assertEquals(JSONObject.NULL, json.get("battery"))
  }
}
