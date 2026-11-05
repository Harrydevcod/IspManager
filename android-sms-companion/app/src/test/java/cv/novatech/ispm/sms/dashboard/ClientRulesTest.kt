package cv.novatech.ispm.sms.dashboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientRulesTest {
  private fun client(name: String, code: String, phone: String?) =
    Dashboard.Client(code, name, phone, "active", null, null, null, 0, null)

  private val joao = client("João Gonçalves", "CL-0007", "+2389912233")
  private val ana = client("Ana Lima", "CL-0012", "+2385801122")
  private val semTelefone = client("Rui", "CL-0020", null)
  private val all = listOf(joao, ana, semTelefone)

  @Test fun searchIgnoresAccentsAndCase() {
    assertEquals(listOf(joao), ClientRules.search(all, "joao"))
    assertEquals(listOf(joao), ClientRules.search(all, "GONÇ"))
  }

  @Test fun searchByCodeAndByPhoneDigits() {
    assertEquals(listOf(ana), ClientRules.search(all, "0012"))
    assertEquals(listOf(joao), ClientRules.search(all, "991 22"))
    // Two digits are too few to mean a phone: no match on numbers.
    assertTrue(ClientRules.search(all, "99").isEmpty())
  }

  @Test fun emptyQueryShowsNothing() {
    assertTrue(ClientRules.search(all, "   ").isEmpty())
  }

  @Test fun callerFoundWhateverPrefixTheNetworkShows() {
    assertEquals(joao, ClientRules.byPhone(all, "+2389912233"))
    assertEquals(joao, ClientRules.byPhone(all, "002389912233"))
    assertEquals(joao, ClientRules.byPhone(all, "9912233"))
  }

  @Test fun unknownOrSharedNumberIsNobody() {
    assertNull(ClientRules.byPhone(all, "+2389000000"))
    assertNull(ClientRules.byPhone(all, null))
    assertNull(ClientRules.byPhone(all, "123"))
    val twin = client("Outro", "CL-0099", "+2389912233")
    assertNull(ClientRules.byPhone(all + twin, "9912233"))
  }

  @Test fun paymentLinkMessageForWhatsAppAndForSms() {
    val link = "https://www.vinti4.cv/pay/abc"
    val wa = FieldRules.paymentLinkMessage(2500, link, forSms = false)
    assertTrue(wa.startsWith("Caro cliente, pode pagar a fatura de 2.500\$00 por este link: $link"))
    val sms = FieldRules.paymentLinkMessage(2500, link, forSms = true)
    assertTrue("SMS sem acentos: $sms", sms.all { it.code < 128 })
  }

  @Test fun prefilledUrisAreEncoded() {
    assertEquals("https://wa.me/2389912233?text=Ol%C3%A1%20a%26b", FieldRules.whatsappUrl("+2389912233", "Olá a&b"))
    assertEquals("smsto:+2389912233?body=Ola%20x", FieldRules.smsUri("+2389912233", "Ola x"))
    assertEquals("smsto:+2389912233", FieldRules.smsUri("+2389912233"))
  }

  @Test fun parsesClientsAndOnlyHttpsLinks() {
    val raw = """
      {"schemaVersion":1,"money":{"debtors":[
        {"clientName":"A","amountCve":2500,"daysOverdue":3,"paymentLink":"https://x.vinti4.cv/p","paymentLinkAmountCve":2500},
        {"clientName":"B","amountCve":100,"daysOverdue":1,"paymentLink":"javascript:alert(1)","paymentLinkAmountCve":100}]},
       "work":{"orders":[],"tickets":[]},
       "clients":[{"code":"CL-1","name":"Ana","phone":null,"status":"suspended","plan":"Fibra 50","overdueCve":500,"lastPaymentAt":"2026-10-05"}]}
    """.trimIndent()
    val d = Dashboard.parse(raw)!!
    assertEquals("https://x.vinti4.cv/p", d.money.debtors[0].paymentLink)
    assertEquals(2500L, d.money.debtors[0].paymentLinkAmountCve)
    assertNull(d.money.debtors[1].paymentLink)
    assertEquals(Dashboard.Client("CL-1", "Ana", null, "suspended", "Fibra 50", null, null, 500, "2026-10-05"), d.clients.single())
  }

  @Test fun olderDesktopHasNoClients() {
    assertTrue(Dashboard.parse("""{"schemaVersion":1}""")!!.clients.isEmpty())
  }
}
