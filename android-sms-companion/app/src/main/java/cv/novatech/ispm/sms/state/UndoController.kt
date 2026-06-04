package cv.novatech.ispm.sms.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Holds armed sends for [delayMillis]; cancel within the window aborts the send. */
class UndoController(
  private val scope: CoroutineScope,
  private val delayMillis: Long = 5000,
  private val onSend: suspend (String) -> Unit
) {
  private val jobs = mutableMapOf<String, Job>()
  val sendingIds: Set<String> get() = jobs.keys.toSet()

  fun arm(id: String, onChange: () -> Unit) {
    jobs.remove(id)?.cancel()
    jobs[id] = scope.launch {
      try {
        delay(delayMillis)
        onSend(id)
      } finally {
        jobs.remove(id)
        onChange()
      }
    }
    onChange()
  }

  fun cancel(id: String, onChange: () -> Unit) {
    jobs.remove(id)?.cancel()
    onChange()
  }
}
