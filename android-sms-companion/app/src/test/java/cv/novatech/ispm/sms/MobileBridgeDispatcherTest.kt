package cv.novatech.ispm.sms

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MobileBridgeDispatcherTest {
  @Test fun limitsConcurrencyAndStopsRepliesAfterClose() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val exited = CountDownLatch(1)
    val replies = AtomicInteger()
    val dispatcher = MobileBridgeDispatcher(maxRequests = 1, maxQueued = 0, process = { _, _, _ ->
      entered.countDown()
      try { release.await(5, TimeUnit.SECONDS); "result" } finally { exited.countDown() }
    }, post = { it() })
    assertTrue(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "one") { replies.incrementAndGet() })
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    assertFalse(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "two") { replies.incrementAndGet() })
    dispatcher.close()
    release.countDown()
    assertFalse(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "three") { replies.incrementAndGet() })
    assertTrue(exited.await(5, TimeUnit.SECONDS))
    assertEquals(0, replies.get())
  }

  @Test fun queuesLimitedBurstWithoutDroppingNormalRequests() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val completed = CountDownLatch(2)
    val dispatcher = MobileBridgeDispatcher(maxRequests = 1, maxQueued = 1, process = { _, _, message ->
      if (message == "first") { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
      message
    }, post = { it() })
    assertTrue(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "first") { completed.countDown() })
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    assertTrue(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "second") { completed.countDown() })
    assertFalse(dispatcher.submit(MobileBridgeHandler.ORIGIN, true, "third") {})
    release.countDown()
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    dispatcher.close()
  }

  @Test fun rejectsUntrustedOriginBeforeScheduling() {
    val dispatcher = MobileBridgeDispatcher(maxRequests = 1, process = { _, _, _ -> throw AssertionError() }, post = { it() })
    assertFalse(dispatcher.submit("https://evil.example", true, "x") {})
    assertFalse(dispatcher.submit(MobileBridgeHandler.ORIGIN, false, "x") {})
    dispatcher.close()
  }
}
