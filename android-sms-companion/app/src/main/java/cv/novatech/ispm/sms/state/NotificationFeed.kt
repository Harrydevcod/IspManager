package cv.novatech.ispm.sms.state

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

/**
 * O histórico do sino, que é comum ao PC e ao telemóvel.
 *
 * A verdade está no PC: o resumo que ele envia traz as últimas entradas com o
 * estado lida/por ler. Aqui guarda-se esse feed e, ao lado, o que nasceu no
 * telemóvel e ainda não voltou confirmado — um SMS que falhou ao enviar, o relé
 * que caiu, o relé que voltou.
 *
 * Regras de junção, iguais às do PC:
 * - "lida" nunca volta a "por ler" (OU entre os dois lados);
 * - "visto até" fica sempre com o maior valor;
 * - uma entrada local que já veio no feed desaparece da lista local.
 *
 * Tudo aqui é puro, para correr na JVM: o `now` entra por parâmetro e o estado
 * vem nos argumentos.
 */

data class NotificationEntry(
  /** Identidade partilhada com o PC: `pc:<id>` ou, nas que nascem aqui, um UUID. */
  val uid: String,
  val kind: String,
  val severity: String,
  val title: String,
  val text: String? = null,
  /** O separador que a toca abre: painel, pedidos, historico, ajustes. */
  val tab: String? = null,
  val at: Long = 0L,
  val read: Boolean = false,
  /** `pc` veio no resumo; `phone` nasceu aqui. */
  val origin: String = "pc",
  /** A linha do Histórico, quando a entrada é um SMS falhado. */
  val requestId: String? = null
)

object NotificationFeed {
  /** O que o sino mostra, e o teto da cache. */
  const val LIMIT = 100

  /** Passados 30 dias nem o PC a manda: deixa de fazer sentido guardá-la. */
  const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000

  /**
   * O que o sino mostra: o feed do PC mais o que nasceu aqui e ainda não voltou
   * confirmado, do mais recente para o mais antigo.
   */
  fun merge(feed: List<NotificationEntry>, local: List<NotificationEntry>, pendingRead: Set<String>): List<NotificationEntry> {
    val known = feed.map { it.uid }.toSet()
    val mine = local.filter { it.uid !in known }
    return (feed + mine)
      .map { if (it.read || it.uid in pendingRead) it.copy(read = true) else it }
      .sortedByDescending { it.at }
      .take(LIMIT)
  }

  /** As locais que o PC já confirmou saem da lista local: ele passou a tê-las. */
  fun keepUnconfirmed(local: List<NotificationEntry>, feed: List<NotificationEntry>): List<NotificationEntry> {
    val known = feed.map { it.uid }.toSet()
    return local.filter { it.uid !in known }
  }

  fun prune(rows: List<NotificationEntry>, now: Long): List<NotificationEntry> =
    rows.filter { now - it.at < RETENTION_MS }.sortedByDescending { it.at }.take(LIMIT)

  /** "Visto até" nunca recua, venha de que lado vier. */
  fun seenAt(feedSeenAt: Long?, localSeenAt: Long?): Long? =
    listOfNotNull(feedSeenAt, localSeenAt).maxOrNull()

  /** O número do sino: alertas de agora mais o que nasceu depois de abrir o painel. */
  fun unseenCount(rows: List<NotificationEntry>, seenAt: Long?): Int =
    rows.count { it.at > (seenAt ?: 0L) }

  /**
   * O histórico que vem dentro do resumo do PC. Ausente numa desktop anterior à
   * 2.74 — então fica só o que nasceu aqui, que é o comportamento de antes.
   */
  fun parseSnapshot(json: String): Pair<List<NotificationEntry>, Long?>? = runCatching {
    val block = JSONObject(json).optJSONObject("notifications") ?: return null
    val array = block.optJSONArray("items") ?: JSONArray()
    val items = (0 until array.length()).mapNotNull { i ->
      val o = array.optJSONObject(i) ?: return@mapNotNull null
      val uid = o.optString("uid")
      if (uid.isBlank()) return@mapNotNull null
      NotificationEntry(
        uid = uid,
        kind = o.optString("kind").ifBlank { "info" },
        severity = o.optString("severity").ifBlank { "info" },
        title = o.optString("title").ifBlank { return@mapNotNull null },
        text = o.optString("detail").ifBlank { null },
        tab = o.optString("tab").ifBlank { "painel" },
        at = parseAt(o.optString("at")),
        read = o.optBoolean("read", false),
        origin = "pc"
      )
    }
    items to parseAt(block.optString("seenAt")).takeIf { it > 0L }
  }.getOrNull()

  /** O PC manda as datas como o SQLite as escreve: "AAAA-MM-DD hh:mm:ss", em UTC. */
  fun parseAt(value: String?): Long {
    if (value.isNullOrBlank()) return 0L
    return runCatching {
      if (value.contains('T')) Instant.parse(value).toEpochMilli()
      else LocalDateTime.parse(value.trim().replace(' ', 'T')).toInstant(ZoneOffset.UTC).toEpochMilli()
    }.getOrDefault(0L)
  }

  fun encode(e: NotificationEntry): JSONObject = JSONObject()
    .put("uid", e.uid)
    .put("kind", e.kind)
    .put("severity", e.severity)
    .put("title", e.title)
    .put("text", e.text ?: "")
    .put("tab", e.tab ?: "")
    .put("at", e.at)
    .put("read", e.read)
    .put("origin", e.origin)
    .put("requestId", e.requestId ?: "")

  fun encodeAll(rows: List<NotificationEntry>): String {
    val array = JSONArray()
    rows.forEach { array.put(encode(it)) }
    return array.toString()
  }

  /** Uma linha estragada descarta-se; o resto da lista sobrevive. */
  fun decode(raw: String): List<NotificationEntry> = try {
    val array = JSONArray(raw)
    (0 until array.length()).mapNotNull { i ->
      try {
        val o = array.getJSONObject(i)
        NotificationEntry(
          uid = o.getString("uid"),
          kind = o.optString("kind").ifBlank { "info" },
          severity = o.optString("severity").ifBlank { "info" },
          title = o.getString("title"),
          text = o.optString("text").ifBlank { null },
          tab = o.optString("tab").ifBlank { null },
          at = o.optLong("at", 0L),
          read = o.optBoolean("read", false),
          origin = o.optString("origin").ifBlank { "pc" },
          requestId = o.optString("requestId").ifBlank { null }
        )
      } catch (_: Exception) {
        null
      }
    }
  } catch (_: Exception) {
    emptyList()
  }
}
