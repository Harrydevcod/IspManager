package cv.novatech.ispm.sms.dashboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Onde o dinheiro do terreno entra. As mesmas regras do PC
 * (`resolveReceiptAccount` em src/backend/lib/treasury.ts): numerário só em
 * caixas, transferência só em bancos.
 */
class ReceiptRulesTest {
  private val caixaLoja = Dashboard.Account(1, "caixa", "Caixa loja", isDefaultCash = true)
  private val caixaCarro = Dashboard.Account(2, "caixa", "Caixa do carro", isDefaultCash = false)
  private val bca = Dashboard.Account(3, "banco", "BCA", isDefaultCash = false)
  private val todas = listOf(caixaLoja, caixaCarro, bca)

  @Test fun numerarioSoVeCaixasETransferenciaSoBancos() {
    assertEquals(listOf(caixaLoja, caixaCarro), ReceiptRules.accountsFor("numerario", todas))
    assertEquals(listOf(bca), ReceiptRules.accountsFor("transferencia", todas))
  }

  @Test fun aCaixaPredefinidaVemEscolhida() {
    assertEquals(caixaLoja, ReceiptRules.preferred("numerario", todas))
  }

  @Test fun comUmaSoContaPossivelNaoHaNadaAEscolher() {
    assertEquals(bca, ReceiptRules.preferred("transferencia", todas))
    assertEquals(caixaCarro, ReceiptRules.preferred("numerario", listOf(caixaCarro, bca)))
  }

  @Test fun semPredefinidaEComVariasEscolheQuemRecebeu() {
    assertNull(ReceiptRules.preferred("numerario", listOf(caixaCarro, caixaLoja.copy(isDefaultCash = false))))
  }

  @Test fun semContasNoResumoAContaFicaParaOPc() {
    assertEquals(emptyList<Dashboard.Account>(), ReceiptRules.accountsFor("numerario", emptyList()))
    assertNull(ReceiptRules.preferred("numerario", emptyList()))
  }
}
