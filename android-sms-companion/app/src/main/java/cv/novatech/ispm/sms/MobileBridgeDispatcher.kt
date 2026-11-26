package cv.novatech.ispm.sms

import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.BlockingQueue
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class MobileBridgeDispatcher(
  maxRequests: Int,
  maxQueued: Int = 8,
  private val process: (String, Boolean, String) -> String?,
  private val post: (() -> Unit) -> Unit
) {
  private val lock = Any()
  private var closed = false
  private var reservedCharacters = 0L
  private val executor: ThreadPoolExecutor = run {
    val workers = maxRequests.coerceIn(1, 4)
    val queue: BlockingQueue<Runnable> = if (maxQueued <= 0) SynchronousQueue() else ArrayBlockingQueue(maxQueued.coerceAtMost(8))
    ThreadPoolExecutor(workers, workers, 30, TimeUnit.SECONDS, queue).apply { allowCoreThreadTimeOut(true) }
  }

  fun submit(origin: String, mainFrame: Boolean, message: String, reply: (String) -> Unit): Boolean {
    if (origin != MobileBridgeHandler.ORIGIN || !mainFrame || message.length > 22_378_000) return false
    synchronized(lock) {
      if (closed) return false
      if (reservedCharacters + message.length > 24_000_000L) return false
      reservedCharacters += message.length
      return try {
        executor.execute {
          val result = try { process(origin, mainFrame, message) } catch (_: Exception) { null }
          finally { synchronized(lock) { if (!closed) reservedCharacters -= message.length } }
          if (result != null) post { synchronized(lock) { if (!closed) reply(result) } }
        }
        true
      } catch (_: RejectedExecutionException) { reservedCharacters -= message.length; false }
    }
  }

  fun close() {
    synchronized(lock) { if (closed) return; closed = true; reservedCharacters = 0 }
    executor.shutdownNow()
  }
}
