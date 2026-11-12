package cv.novatech.ispm.sms.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.Freshness
import cv.novatech.ispm.sms.state.SyncPhase
import cv.novatech.ispm.sms.state.SyncRules
import cv.novatech.ispm.sms.ui.components.*
import cv.novatech.ispm.sms.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Painel: a read-only glance at the operation, pushed by the desktop. Ordered by
 * what the owner checks first: is anything on fire, is money coming in, is the
 * network up, then the day-to-day counts. One figure leads (the month's takings);
 * everything else is a ledger row, so the eye lands once and then scans.
 */
@Composable
fun DashboardScreen(
  dashboard: Dashboard?,
  receivedAt: Long?,
  syncRequestedAt: Long? = null,
  onSync: () -> Unit = {},
  onToggleTheme: (() -> Unit)? = null
) {
  // Re-render every 30 s so "há N min" and the stale state move on their own.
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) { delay(30_000); now = System.currentTimeMillis() }
  }
  val freshness = DashboardRules.freshness(receivedAt, now)
  val sync = SyncRules.phase(syncRequestedAt, receivedAt, now)

  if (dashboard == null || freshness == Freshness.NONE) {
    WaitingForDesktop(sync, onSync, onToggleTheme)
    return
  }

  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 32.dp)) {
    item { Header(dashboard.companyName, statusLine(sync, freshness, now - receivedAt!!), sync, onSync, onToggleTheme) }
    item { Section(16) { OperationBand(dashboard.operation) } }
    item { Section { MoneySection(dashboard.money, dashboard.hasFieldData) } }
    item { Section { NetworkSection(dashboard.network) } }
    item { Section { CustomersSection(dashboard.customers) } }
    item { Section { SmsSection(dashboard.sms) } }
  }
}

/** Sections are spaced, not boxed: 28 dp of air says "new subject" without a card. */
@Composable
private fun Section(top: Int = 28, content: @Composable ColumnScope.() -> Unit) =
  Column(Modifier.fillMaxWidth().padding(top = top.dp), content = content)

/** The line under the company name: the sync when one is out, else how fresh the data is. */
@Composable
private fun statusLine(sync: SyncPhase, freshness: Freshness, age: Long): Pair<String, Color> = when {
  sync == SyncPhase.WAITING -> "A aguardar o ISPM" to TextSecondary
  sync == SyncPhase.NO_ANSWER -> "O ISPM não respondeu. O PC está ligado e na mesma rede?" to Warn
  freshness == Freshness.STALE -> "Sem dados novos ${DashboardRules.ago(age)}. PC desligado ou fora da rede?" to Warn
  else -> "Atualizado ${DashboardRules.ago(age)}" to TextMuted
}

@Composable
private fun Header(title: String, line: Pair<String, Color>, sync: SyncPhase, onSync: () -> Unit, onToggleTheme: (() -> Unit)?) {
  Row(verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
      Text(title, color = TextPrimary, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Spacer(Modifier.height(2.dp))
      Text(line.first, color = line.second, style = MaterialTheme.typography.bodySmall)
    }
    if (onToggleTheme != null) ThemeToggle(onToggleTheme)
    SyncButton(sync, onSync)
  }
}

/** Sun in the dark (go light), moon in the light (go dark). */
@Composable
fun ThemeToggle(onToggle: () -> Unit) {
  val dark = LocalIspmColors.current.isDark
  IconButton(onClick = onToggle) {
    Icon(
      if (dark) Lucide.Sun else Lucide.Moon,
      contentDescription = if (dark) "Mudar para tema claro" else "Mudar para tema escuro",
      tint = TextSecondary, modifier = Modifier.size(20.dp)
    )
  }
}

// 48 dp target (IconButton default); disabled while a request is already out.
@Composable
private fun SyncButton(sync: SyncPhase, onSync: () -> Unit) {
  IconButton(onClick = onSync, enabled = sync != SyncPhase.WAITING) {
    if (sync == SyncPhase.WAITING) CircularProgressIndicator(Modifier.size(18.dp), color = Accent, strokeWidth = 2.dp)
    else Icon(Lucide.RefreshCw, contentDescription = "Sincronizar", tint = TextSecondary, modifier = Modifier.size(20.dp))
  }
}

/** Nothing from the PC yet: the action that fixes it, over the faint shape of what will come. */
@Composable
private fun WaitingForDesktop(sync: SyncPhase, onSync: () -> Unit, onToggleTheme: (() -> Unit)?) {
  Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
    val line = when (sync) {
      SyncPhase.WAITING -> "A aguardar o ISPM" to TextSecondary
      SyncPhase.NO_ANSWER -> "O ISPM não respondeu. O PC está ligado e na mesma rede?" to Warn
      SyncPhase.IDLE -> "Ainda sem resumo do PC" to TextMuted
    }
    Header("Painel", line, sync, onSync, onToggleTheme)
    Spacer(Modifier.height(16.dp))
    IspmButton(
      "Sincronizar", onSync, Modifier.fillMaxWidth(), ButtonVariant.PRIMARY,
      enabled = sync != SyncPhase.WAITING, icon = Lucide.RefreshCw
    )
    Spacer(Modifier.height(32.dp))
    // ponytail: a static placeholder of the Painel's shape, not a shimmer; the wait can be minutes, not ms.
    Column(Modifier.alpha(0.55f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Placeholder(Modifier.fillMaxWidth().height(96.dp))
      Spacer(Modifier.height(12.dp))
      Placeholder(Modifier.width(140.dp).height(14.dp))
      Placeholder(Modifier.width(220.dp).height(30.dp))
      repeat(3) { Placeholder(Modifier.fillMaxWidth().height(16.dp)) }
    }
  }
}

@Composable
private fun Placeholder(modifier: Modifier) = Box(modifier.clip(RoundedCornerShape(8.dp)).background(Surface3))

private fun severityLabel(severity: String): String = when (severity) {
  "red" -> "Crítico"
  "amber" -> "Atenção"
  else -> "Tudo normal"
}

/** The one card on the Painel: tinted by severity, so the state reads before any word does. */
@Composable
private fun OperationBand(op: Dashboard.Operation) {
  val tone = severityColor(op.severity)
  Column(
    Modifier.fillMaxWidth()
      .clip(MaterialTheme.shapes.medium).background(severityBg(op.severity))
      .padding(16.dp)
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      StatusDot(tone)
      Spacer(Modifier.width(8.dp))
      Text(severityLabel(op.severity), color = tone, style = MaterialTheme.typography.labelMedium)
    }
    Spacer(Modifier.height(6.dp))
    Text(op.headline, color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    if (op.risks.isNotEmpty()) ItemList("Riscos", op.risks)
    if (op.actions.isNotEmpty()) ItemList("A fazer", op.actions)
  }
}

@Composable
private fun ItemList(title: String, items: List<Dashboard.Item>) {
  Spacer(Modifier.height(14.dp))
  Text(title, color = TextSecondary, style = MaterialTheme.typography.labelMedium)
  items.take(3).forEach { item ->
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.Top) {
      Box(Modifier.padding(top = 7.dp)) { StatusDot(severityColor(item.severity), size = 6) }
      Spacer(Modifier.width(10.dp))
      Column {
        Text(item.title, color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
        if (item.detail.isNotBlank()) {
          Text(item.detail, color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

@Composable
private fun MoneySection(m: Dashboard.Money, hasFieldData: Boolean) {
  Text("Recebido este mês", color = TextSecondary, style = MaterialTheme.typography.bodyMedium)
  Text(DashboardRules.formatCve(m.paidMonthCve), color = TextPrimary, style = MaterialTheme.typography.headlineLarge)
  Text("Mês anterior ${DashboardRules.formatCve(m.paidPrevMonthCve)}", color = TextMuted, style = MaterialTheme.typography.labelSmall)
  Spacer(Modifier.height(12.dp))
  if (hasFieldData) {
    val accounts = m.cashToday.byAccount.joinToString(" · ") { "${it.name} ${DashboardRules.formatCve(it.amountCve)}" }
    LedgerRow("Caixa de hoje", DashboardRules.formatCve(m.cashToday.totalCve), detail = accounts.ifBlank { "Ainda sem recebimentos" })
    Hairline()
  }
  LedgerRow("Por receber este mês", DashboardRules.formatCve(m.pendingMonthCve), detail = faturas(m.pendingMonthCount))
  Hairline()
  LedgerRow(
    "Em atraso", DashboardRules.formatCve(m.pendingPreviousCve),
    valueColor = if (m.overduePayments > 0) Danger else TextPrimary, detail = faturas(m.overduePayments)
  )
  if (hasFieldData && m.monthlyReceipts.isNotEmpty()) {
    Spacer(Modifier.height(20.dp))
    SectionHeader("Últimos 6 meses")
    Spacer(Modifier.height(8.dp))
    MonthBars(m.monthlyReceipts)
  }
  if (m.criticalOverdue.isNotEmpty()) {
    Spacer(Modifier.height(20.dp))
    SectionHeader("Mais de 30 dias", m.criticalOverdue.size)
    m.criticalOverdue.forEach { d ->
      Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(d.clientName, color = TextPrimary, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        Text("${d.daysOverdue} d", color = TextMuted, style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.width(12.dp))
        Text(DashboardRules.formatCve(d.amountCve), color = Danger, style = MaterialTheme.typography.titleSmall)
      }
    }
  }
}

private fun faturas(n: Int) = if (n == 1) "1 fatura" else "$n faturas"

private val monthNames = listOf("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")

/** Six plain bars, the current month in the accent; the tallest carries its value. */
@Composable
private fun MonthBars(months: List<Dashboard.MonthAmount>) {
  val max = months.maxOf { it.amountCve }.coerceAtLeast(1)
  Row(Modifier.fillMaxWidth().height(116.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
    months.forEachIndexed { i, m ->
      val current = i == months.lastIndex
      Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.Bottom, horizontalAlignment = Alignment.CenterHorizontally) {
        if (m.amountCve == max) {
          // Wider than one bar: it spills over the air beside it rather than being cut.
          Text(
            DashboardRules.formatCve(m.amountCve).removeSuffix("\$00") + "$", color = TextSecondary,
            style = MaterialTheme.typography.labelSmall, maxLines = 1, softWrap = false,
            modifier = Modifier.wrapContentWidth(unbounded = true)
          )
          Spacer(Modifier.height(4.dp))
        }
        Box(
          Modifier.fillMaxWidth()
            .fillMaxHeight((m.amountCve.toFloat() / max * 0.76f).coerceAtLeast(0.02f))
            .clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
            .background(if (current) Accent else Border2)
        )
        Spacer(Modifier.height(6.dp))
        val idx = m.month.substringAfter('-').toIntOrNull()?.minus(1)
        Text(idx?.let { monthNames.getOrNull(it) } ?: m.month, color = if (current) TextPrimary else TextMuted, style = MaterialTheme.typography.labelSmall)
      }
    }
  }
}

@Composable
private fun NetworkSection(n: Dashboard.Network) {
  val (summary, tone) = when {
    n.downCount > 0 -> "${n.downCount} em baixo" to Danger
    n.tone == "warn" -> "Com avisos" to Warn
    else -> "Tudo a funcionar" to Success
  }
  SectionHeader("Rede") {
    Row(verticalAlignment = Alignment.CenterVertically) {
      StatusDot(tone)
      Spacer(Modifier.width(6.dp))
      Text(summary, color = tone, style = MaterialTheme.typography.labelMedium)
    }
  }
  // The list now comes whole (for the alerts); the Painel shows the first five.
  n.downNow.take(5).forEach { d ->
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
      StatusDot(Danger, size = 6)
      Spacer(Modifier.width(10.dp))
      Text(d.name, color = TextPrimary, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
  if (n.downNow.size > 5) {
    Text("e mais ${n.downNow.size - 5}", color = TextMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 16.dp, top = 2.dp))
  }
  Spacer(Modifier.height(8.dp))
  val wans = n.wans
  if (wans == null) {
    LedgerRow("Ligações à Internet", n.wanReason ?: "Router sem leitura", valueColor = TextMuted)
  } else {
    wans.forEachIndexed { i, w ->
      if (i > 0 || n.downNow.isNotEmpty()) Hairline()
      Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(if (w.running) Success else Danger, size = 6)
        Spacer(Modifier.width(10.dp))
        Text(w.name, color = TextSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(
          if (w.running) "↓ ${DashboardRules.formatBps(w.downBps)}  ↑ ${DashboardRules.formatBps(w.upBps)}" else "em baixo",
          color = if (w.running) TextPrimary else Danger, style = MaterialTheme.typography.labelMedium
        )
      }
    }
  }
  Hairline()
  LedgerRow("Achados nas últimas 24 h", n.findingsCount.toString(), valueColor = if (n.findingsCount > 0) Warn else TextPrimary)
}

@Composable
private fun CustomersSection(c: Dashboard.Customers) {
  SectionHeader("Clientes e trabalho")
  Spacer(Modifier.height(10.dp))
  Row(Modifier.fillMaxWidth()) {
    Stat("Ativos", c.active.toString(), "de ${c.total}", Modifier.weight(1f))
    Stat("Suspensos", c.suspended.toString(), null, Modifier.weight(1f), if (c.suspended > 0) Warn else TextPrimary)
  }
  Spacer(Modifier.height(14.dp))
  Row(Modifier.fillMaxWidth()) {
    Stat("OS abertas", c.openWorkOrders.toString(), null, Modifier.weight(1f))
    Stat("Assistência", c.openTickets.toString(), "pedidos abertos", Modifier.weight(1f))
  }
}

/** A small figure with its label above: the grid is for comparing, not for headlines. */
@Composable
private fun Stat(label: String, value: String, caption: String?, modifier: Modifier, color: Color = TextPrimary) {
  Column(modifier) {
    Text(label, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
    Row(verticalAlignment = Alignment.Bottom) {
      Text(value, color = color, style = MaterialTheme.typography.headlineSmall)
      if (caption != null) {
        Spacer(Modifier.width(6.dp))
        Text(caption, color = TextMuted, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(bottom = 3.dp))
      }
    }
  }
}

@Composable
private fun SmsSection(sms: Dashboard.Sms) {
  SectionHeader("SMS")
  SmsRow("Hoje", sms.today)
  Hairline()
  SmsRow("Este mês", sms.month)
}

@Composable
private fun SmsRow(label: String, s: Dashboard.SmsCounts) {
  Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(label, color = TextSecondary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    Text("${s.sent} enviados · ${s.delivered} entregues", color = TextPrimary, style = MaterialTheme.typography.labelMedium)
    if (s.failed > 0) Text(" · ${s.failed} falhados", color = Danger, style = MaterialTheme.typography.labelMedium)
  }
}

/** A tappable row on the Terreno: one surface, no nesting. */
@Composable
internal fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Column(
    modifier.fillMaxWidth()
      .clip(MaterialTheme.shapes.medium).background(Surface)
      .border(1.dp, BorderC, MaterialTheme.shapes.medium)
      .padding(16.dp),
    content = content
  )
}
