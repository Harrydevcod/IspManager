package cv.novatech.ispm.sms.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationFeedTest {
  private val now = 1_700_000_000_000L

  private fun entry(uid: String, at: Long = now, read: Boolean = false, origin: String = "pc") =
    NotificationEntry(uid = uid, kind = "network_down", severity = "danger", title = "CIBEL_AP em baixo",
      text = "192.168.88.21", tab = "painel", at = at, read = read, origin = origin)

  @Test fun `a lista junta o feed do PC com o que nasceu aqui`() {
    val feed = listOf(entry("pc:1", at = now - 1000))
    val local = listOf(entry("abc", at = now, origin = "phone"))
    assertEquals(listOf("abc", "pc:1"), NotificationFeed.merge(feed, local, emptySet()).map { it.uid })
  }

  @Test fun `uma local que ja veio no feed nao aparece duas vezes`() {
    val feed = listOf(entry("abc", origin = "phone"))
    val local = listOf(entry("abc", origin = "phone"))
    assertEquals(1, NotificationFeed.merge(feed, local, emptySet()).size)
    assertEquals(emptyList<NotificationEntry>(), NotificationFeed.keepUnconfirmed(local, feed))
  }

  @Test fun `tocar marca como lida ate o feed confirmar`() {
    val feed = listOf(entry("pc:1", read = false))
    assertTrue(NotificationFeed.merge(feed, emptyList(), setOf("pc:1")).single().read)
  }

  @Test fun `lida no PC fica lida aqui`() {
    val feed = listOf(entry("pc:1", read = true))
    assertTrue(NotificationFeed.merge(feed, emptyList(), emptySet()).single().read)
  }

  @Test fun `a lista fica pelas cem mais recentes`() {
    val feed = (1..150).map { entry("pc:$it", at = now - it * 1000L) }
    val merged = NotificationFeed.merge(feed, emptyList(), emptySet())
    assertEquals(NotificationFeed.LIMIT, merged.size)
    assertEquals("pc:1", merged.first().uid)
  }

  @Test fun `passados trinta dias a entrada sai`() {
    val velha = entry("pc:1", at = now - NotificationFeed.RETENTION_MS - 1)
    val nova = entry("pc:2", at = now)
    assertEquals(listOf("pc:2"), NotificationFeed.prune(listOf(velha, nova), now).map { it.uid })
  }

  @Test fun `visto ate fica com o maior dos dois`() {
    assertEquals(now, NotificationFeed.seenAt(now, now - 5000))
    assertEquals(now, NotificationFeed.seenAt(now - 5000, now))
    assertEquals(now, NotificationFeed.seenAt(null, now))
    assertNull(NotificationFeed.seenAt(null, null))
  }

  @Test fun `por ver conta o que nasceu depois de abrir o painel`() {
    val rows = listOf(entry("pc:1", at = now), entry("pc:2", at = now - 10_000))
    assertEquals(1, NotificationFeed.unseenCount(rows, now - 5_000))
    assertEquals(0, NotificationFeed.unseenCount(rows, now))
    assertEquals(2, NotificationFeed.unseenCount(rows, null))
  }

  @Test fun `o codec faz o round-trip`() {
    val row = entry("abc", origin = "phone").copy(requestId = "req-1")
    val back = NotificationFeed.decode(NotificationFeed.encodeAll(listOf(row))).single()
    assertEquals(row, back)
  }

  @Test fun `uma linha estragada descarta-se sem levar a lista`() {
    val raw = """[{"uid":"pc:1","title":"Boa","at":1},{"sem":"uid"},{"uid":"pc:2","title":"Outra","at":2}]"""
    assertEquals(listOf("pc:1", "pc:2"), NotificationFeed.decode(raw).map { it.uid })
  }

  @Test fun `o historico vem dentro do resumo do PC`() {
    val json = """
      {"schemaVersion":1,"notifications":{"seenAt":"2026-11-19 09:30:00","items":[
        {"uid":"pc:7","kind":"network_down","severity":"danger","title":"CIBEL_AP em baixo",
         "detail":"192.168.88.21","tab":"painel","at":"2026-11-19 09:00:00","read":false}]}}
    """.trimIndent()
    val (items, seenAt) = NotificationFeed.parseSnapshot(json)!!
    val row = items.single()
    assertEquals("pc:7", row.uid)
    assertEquals("pc", row.origin)
    assertEquals("painel", row.tab)
    assertEquals(false, row.read)
    // As datas vêm como o SQLite as escreve, em UTC.
    assertEquals(NotificationFeed.parseAt("2026-11-19 09:00:00"), row.at)
    assertEquals(NotificationFeed.parseAt("2026-11-19 09:30:00"), seenAt)
  }

  @Test fun `um resumo sem o campo deixa ficar o que nasceu aqui`() {
    assertNull(NotificationFeed.parseSnapshot("""{"schemaVersion":1,"companyName":"Novatech"}"""))
    assertNull(NotificationFeed.parseSnapshot("nao e json"))
  }

  @Test fun `uma entrada sem titulo nao entra`() {
    val json = """{"notifications":{"items":[{"uid":"pc:1"},{"uid":"pc:2","title":"Boa","at":"2026-11-19 09:00:00"}]}}"""
    assertEquals(listOf("pc:2"), NotificationFeed.parseSnapshot(json)!!.first.map { it.uid })
  }

  @Test fun `um ficheiro ilegivel le-se como lista vazia`() {
    assertEquals(emptyList<NotificationEntry>(), NotificationFeed.decode("isto nao e json"))
  }
}
