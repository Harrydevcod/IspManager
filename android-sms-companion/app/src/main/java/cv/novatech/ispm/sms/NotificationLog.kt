package cv.novatech.ispm.sms

import android.content.Context
import cv.novatech.ispm.sms.state.NotificationEntry
import cv.novatech.ispm.sms.state.NotificationFeed

/**
 * Onde fica o histórico do sino neste telemóvel.
 *
 * É uma cache, não a verdade: o feed vem do PC em cada resumo. Ao lado guarda-se
 * o que nasceu aqui e ainda não voltou confirmado, e os `uid` que já foram
 * tocados mas que o PC ainda não sabe que foram lidos (leitura otimista).
 *
 * Mesmo padrão do [SmsRequestStore]: SharedPreferences com JSON e `commit()`,
 * sem Room nem DataStore — nada de dependências novas por causa disto.
 */
class NotificationLog(context: Context) {
  private val prefs = context.getSharedPreferences("notification_log", Context.MODE_PRIVATE)

  /** O que o sino mostra: o feed do PC mais o que ainda não lhe chegou. */
  @Synchronized fun list(): List<NotificationEntry> =
    NotificationFeed.merge(feed(), local(), pendingRead())

  @Synchronized fun seenAt(): Long? = NotificationFeed.seenAt(
    prefs.getLong(FEED_SEEN, 0L).takeIf { it > 0L },
    prefs.getLong(SEEN, 0L).takeIf { it > 0L }
  )

  /** Uma entrada que nasce aqui (SMS falhado, relé caiu, relé voltou). */
  @Synchronized fun append(entry: NotificationEntry) {
    write(LOCAL, NotificationFeed.prune(local().filter { it.uid != entry.uid } + entry, entry.at))
  }

  /** Tocar marca já como lida; o `uid` fica à espera da confirmação do PC. */
  @Synchronized fun markRead(uid: String) {
    prefs.edit().putStringSet(PENDING, pendingRead() + uid).commit()
  }

  @Synchronized fun markAllRead(): List<String> {
    val uids = list().filterNot { it.read }.map { it.uid }
    if (uids.isNotEmpty()) prefs.edit().putStringSet(PENDING, pendingRead() + uids).commit()
    return uids
  }

  /** Abrir o painel: o número desaparece, as entradas continuam por ler. */
  @Synchronized fun markSeen(now: Long) {
    prefs.edit().putLong(SEEN, maxOf(now, prefs.getLong(SEEN, 0L))).commit()
  }

  /**
   * Chegou um resumo com o histórico: o feed do PC substitui o que havia, as
   * locais que ele já tem saem da lista local, e os `uid` que ele já dá como
   * lidos deixam de estar à espera.
   */
  @Synchronized fun acceptFeed(items: List<NotificationEntry>, feedSeenAt: Long?) {
    val confirmedRead = items.filter { it.read }.map { it.uid }.toSet()
    write(FEED, items)
    write(LOCAL, NotificationFeed.keepUnconfirmed(local(), items))
    prefs.edit()
      .putStringSet(PENDING, pendingRead() - confirmedRead)
      .putLong(FEED_SEEN, maxOf(feedSeenAt ?: 0L, prefs.getLong(FEED_SEEN, 0L)))
      .commit()
  }

  /** Corre no arranque, ao lado do `RequestRules.prune`. */
  @Synchronized fun prune(now: Long) {
    write(FEED, NotificationFeed.prune(feed(), now))
    write(LOCAL, NotificationFeed.prune(local(), now))
  }

  private fun feed() = NotificationFeed.decode(prefs.getString(FEED, "[]") ?: "[]")
  private fun local() = NotificationFeed.decode(prefs.getString(LOCAL, "[]") ?: "[]")
  private fun pendingRead(): Set<String> = prefs.getStringSet(PENDING, emptySet()) ?: emptySet()

  private fun write(key: String, rows: List<NotificationEntry>) {
    prefs.edit().putString(key, NotificationFeed.encodeAll(rows)).commit()
  }

  private companion object {
    const val FEED = "feed"
    const val LOCAL = "local"
    const val PENDING = "pendingRead"
    const val SEEN = "seenAt"
    const val FEED_SEEN = "feedSeenAt"
  }
}
