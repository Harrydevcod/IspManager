package cv.novatech.ispm.sms.state

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UndoControllerTest {
  @Test fun sendsAfterWindowElapses() = runTest {
    val sent = mutableListOf<String>()
    val undo = UndoController(this, delayMillis = 5000, onSend = { sent.add(it) })
    undo.arm("1") {}
    assertTrue(undo.sendingIds.contains("1"))
    advanceTimeBy(5001)
    assertEquals(listOf("1"), sent)
    assertFalse(undo.sendingIds.contains("1"))
  }

  @Test fun cancelPreventsSend() = runTest {
    val sent = mutableListOf<String>()
    val undo = UndoController(this, delayMillis = 5000, onSend = { sent.add(it) })
    undo.arm("1") {}
    undo.cancel("1") {}
    assertFalse(undo.sendingIds.contains("1"))
    advanceTimeBy(6000)
    assertTrue(sent.isEmpty())
  }
}
