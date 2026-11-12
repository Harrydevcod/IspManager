package cv.novatech.ispm.sms.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.Freshness
import cv.novatech.ispm.sms.state.SyncPhase
import cv.novatech.ispm.sms.state.SyncRules
import cv.novatech.ispm.sms.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Painel: a read-only glance at the operation, pushed by the desktop. Ordered by
 * what the owner checks first — is anything on fire, is money coming in, is the
 * network up, then the day-to-day counts.
 */
@Composable
fun DashboardScreen(dashboard: Dashboard?, receivedAt: Long?, syncRequestedAt: Long? = null, onSync: () -> Unit = {}) {
  // Re-render every 30 s so "há N min" and the stale state move on their own.
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) { delay(30_000); now = System.currentTimeMillis() }
  }
  val freshness = DashboardRules.freshness(receivedAt, now)
  val sync = SyncRules.phase(syncRequestedAt, receivedAt, now)

  if (dashboard == null || freshness == Freshness.NONE) {
    WaitingForDesktop(sync, onSync)
    return
  }

  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Header(dashboard.companyName, receivedAt!!, now, freshness, sync, onSync) }
    item { OperationCard(dashboard.operation) }
    if (dashboard.hasFieldData) item { CashTodayCard(dashboard.money) }
    item { MoneyCard(dashboard.money) }
    item { NetworkCard(dashboard.network) }
    item { CustomersCard(dashboard.customers, dashboard.sms) }
  }
}

@Composable
private fun WaitingForDesktop(sync: SyncPhase, onSync: () -> Unit) {
  Column(
    Modifier.fillMaxSize().padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("À espera do ISPM", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(16.dp))
    OutlinedButton(onClick = onSync, enabled = sync != SyncPhase.WAITING) {
      SyncGlyph(sync)
      Spacer(Modifier.width(8.dp))
      Text("Sincronizar", color = TextPrimary)
    }
    syncLine(sync)?.let { (text, color) ->
      Spacer(Modifier.height(8.dp))
      Text(text, color = color, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
    }
  }
}

/** What the sync is doing, when it is doing something; null = show the usual freshness. */
private fun syncLine(sync: SyncPhase): Pair<String, Color>? = when (sync) {
  SyncPhase.WAITING -> "A aguardar o ISPM" to TextSecondary
  SyncPhase.NO_ANSWER -> "O ISPM não respondeu. O PC está ligado e na mesma rede?" to Warn
  SyncPhase.IDLE -> null
}

@Composable
private fun SyncGlyph(sync: SyncPhase) {
  if (sync == SyncPhase.WAITING) {
    CircularProgressIndicator(Modifier.size(18.dp), color = AccentBlue, strokeWidth = 2.dp)
  } else {
    Icon(Icons.Filled.Refresh, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(20.dp))
  }
}

@Composable
private fun Header(company: String, receivedAt: Long, now: Long, freshness: Freshness, sync: SyncPhase, onSync: () -> Unit) {
  val stale = freshness == Freshness.STALE
  val (line, lineColor) = syncLine(sync)
    ?: if (stale) "Sem dados novos ${DashboardRules.ago(now - receivedAt)}. PC desligado ou fora da rede?" to Warn
    else "Atualizado ${DashboardRules.ago(now - receivedAt)}" to TextMuted
  Row(verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) {
      Text(company, color = TextPrimary, style = MaterialTheme.typography.titleLarge)
      Spacer(Modifier.height(2.dp))
      Text(line, color = lineColor, style = MaterialTheme.typography.bodySmall)
    }
    // 48 dp target (IconButton default); disabled while a request is already out.
    IconButton(onClick = onSync, enabled = sync != SyncPhase.WAITING) {
      if (sync == SyncPhase.WAITING) SyncGlyph(sync)
      else Icon(Icons.Filled.Refresh, contentDescription = "Sincronizar", tint = TextSecondary)
    }
  }
}

private fun severityColor(severity: String): Color = when (severity) {
  "red" -> Danger
  "amber" -> Warn
  else -> Success
}

private fun severityLabel(severity: String): String = when (severity) {
  "red" -> "Crítico"
  "amber" -> "Atenção"
  else -> "Normal"
}

@Composable
internal fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Column(
    modifier.fillMaxWidth()
      .clip(RoundedCornerShape(16.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(16.dp))
      .padding(16.dp),
    content = content
  )
}

@Composable
internal fun Eyebrow(text: String) {
  Text(text.uppercase(), color = TextMuted, style = MaterialTheme.typography.labelSmall)
}

@Composable
private fun OperationCard(op: Dashboard.Operation) {
  val color = severityColor(op.severity)
  Card {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(Modifier.size(8.dp).clip(CircleShape).background(color))
      Spacer(Modifier.width(8.dp))
      Text(severityLabel(op.severity).uppercase(), color = color, style = MaterialTheme.typography.labelSmall)
    }
    Spacer(Modifier.height(8.dp))
    Text(op.headline, color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    if (op.risks.isNotEmpty()) {
      Spacer(Modifier.height(14.dp))
      Eyebrow("Riscos")
      op.risks.take(3).forEach { ItemRow(it) }
    }
    if (op.actions.isNotEmpty()) {
      Spacer(Modifier.height(14.dp))
      Eyebrow("A fazer")
      op.actions.take(3).forEach { ItemRow(it) }
    }
  }
}

@Composable
private fun ItemRow(item: Dashboard.Item) {
  Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.Top) {
    Box(Modifier.padding(top = 6.dp).size(5.dp).clip(CircleShape).background(severityColor(item.severity)))
    Spacer(Modifier.width(10.dp))
    Column {
      Text(item.title, color = TextPrimary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
      if (item.detail.isNotBlank()) {
        Text(item.detail, color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun MoneyCard(m: Dashboard.Money) {
  Card {
    Eyebrow("Recebido este mês")
    Spacer(Modifier.height(4.dp))
    Text(DashboardRules.formatCve(m.paidMonthCve), color = TextPrimary, style = MaterialTheme.typography.headlineMedium)
    Text(
      "Mês anterior: ${DashboardRules.formatCve(m.paidPrevMonthCve)}",
      color = TextMuted, style = MaterialTheme.typography.bodySmall
    )
    Spacer(Modifier.height(14.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Figure("Por receber (mês)", DashboardRules.formatCve(m.pendingMonthCve), "${m.pendingMonthCount} faturas", TextPrimary, Modifier.weight(1f))
      Figure("Em atraso", DashboardRules.formatCve(m.pendingPreviousCve), "${m.overduePayments} faturas", if (m.overduePayments > 0) Danger else TextPrimary, Modifier.weight(1f))
    }
    if (m.criticalOverdue.isNotEmpty()) {
      Spacer(Modifier.height(14.dp))
      Eyebrow("Mais de 30 dias")
      m.criticalOverdue.forEach { d ->
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(d.clientName, color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
          Spacer(Modifier.width(8.dp))
          Text("${d.daysOverdue} d", color = TextMuted, style = MaterialTheme.typography.labelSmall)
          Spacer(Modifier.width(10.dp))
          Text(DashboardRules.formatCve(d.amountCve), color = TextPrimary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        }
      }
    }
  }
}

/** Today's till first (what came in, and where it is), then six months at a glance. */
@Composable
private fun CashTodayCard(m: Dashboard.Money) {
  Card {
    Eyebrow("Caixa de hoje")
    Spacer(Modifier.height(4.dp))
    Text(DashboardRules.formatCve(m.cashToday.totalCve), color = TextPrimary, style = MaterialTheme.typography.headlineMedium)
    if (m.cashToday.byAccount.isEmpty()) {
      Text("Ainda sem recebimentos hoje", color = TextMuted, style = MaterialTheme.typography.bodySmall)
    }
    m.cashToday.byAccount.forEach { a ->
      Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Text(a.name, color = TextSecondary, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(DashboardRules.formatCve(a.amountCve), color = TextPrimary, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
      }
    }
    if (m.monthlyReceipts.isNotEmpty()) {
      Spacer(Modifier.height(16.dp))
      Eyebrow("Recebido por mês")
      Spacer(Modifier.height(10.dp))
      MonthBars(m.monthlyReceipts)
    }
  }
}

private val monthNames = listOf("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")

/** Six plain bars, the current month highlighted; the value of the tallest is written above it. */
@Composable
private fun MonthBars(months: List<Dashboard.MonthAmount>) {
  val max = months.maxOf { it.amountCve }.coerceAtLeast(1)
  Row(Modifier.fillMaxWidth().height(120.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
    months.forEachIndexed { i, m ->
      val current = i == months.lastIndex
      Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.Bottom, horizontalAlignment = Alignment.CenterHorizontally) {
        if (m.amountCve == max) {
          Text(
            DashboardRules.formatCve(m.amountCve).removeSuffix("\$00") + "$", color = TextSecondary,
            style = MaterialTheme.typography.labelSmall, maxLines = 1, softWrap = false,
            modifier = Modifier.wrapContentWidth(unbounded = true)
          )
          Spacer(Modifier.height(4.dp))
        }
        Box(
          Modifier.fillMaxWidth()
            .fillMaxHeight((m.amountCve.toFloat() / max * 0.78f).coerceAtLeast(0.02f))
            .clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp))
            .background(if (current) AccentBlue else BorderStrong)
        )
        Spacer(Modifier.height(6.dp))
        val idx = m.month.substringAfter('-').toIntOrNull()?.minus(1)
        Text(idx?.let { monthNames.getOrNull(it) } ?: m.month, color = if (current) TextPrimary else TextMuted, style = MaterialTheme.typography.labelSmall)
      }
    }
  }
}

@Composable
private fun Figure(label: String, value: String, caption: String?, color: Color, modifier: Modifier = Modifier) {
  Column(modifier) {
    Text(label, color = TextMuted, style = MaterialTheme.typography.bodySmall, maxLines = 1)
    Text(value, color = color, style = MaterialTheme.typography.headlineSmall, maxLines = 1)
    if (caption != null) Text(caption, color = TextMuted, style = MaterialTheme.typography.labelSmall)
  }
}

@Composable
private fun NetworkCard(n: Dashboard.Network) {
  val toneColor = when (n.tone) { "danger" -> Danger; "warn" -> Warn; else -> Success }
  Card {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Eyebrow("Rede")
      Spacer(Modifier.width(8.dp))
      Box(Modifier.size(6.dp).clip(CircleShape).background(toneColor))
    }
    Spacer(Modifier.height(6.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Figure("Em baixo agora", n.downCount.toString(), null, if (n.downCount > 0) Danger else TextPrimary, Modifier.weight(1f))
      Figure("Achados (24 h)", n.findingsCount.toString(), null, if (n.findingsCount > 0) Warn else TextPrimary, Modifier.weight(1f))
    }
    // The list now comes whole (for the alerts); the card shows the first five.
    n.downNow.take(5).forEach { d ->
      Text("• ${d.name}", color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
    }
    if (n.downNow.size > 5) {
      Text("e mais ${n.downNow.size - 5}", color = TextMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
    }
    Spacer(Modifier.height(12.dp))
    Eyebrow("Ligações à Internet")
    val wans = n.wans
    if (wans == null) {
      Text(n.wanReason ?: "Router sem leitura", color = TextMuted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
    } else {
      wans.forEach { w ->
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.size(6.dp).clip(CircleShape).background(if (w.running) Success else Danger))
          Spacer(Modifier.width(8.dp))
          Text(w.name, color = TextPrimary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
          Text(
            if (w.running) "↓ ${DashboardRules.formatBps(w.downBps)}  ↑ ${DashboardRules.formatBps(w.upBps)}" else "em baixo",
            color = if (w.running) TextSecondary else Danger, style = MaterialTheme.typography.bodySmall
          )
        }
      }
    }
  }
}

@Composable
private fun CustomersCard(c: Dashboard.Customers, sms: Dashboard.Sms) {
  Card {
    Eyebrow("Clientes e trabalho")
    Spacer(Modifier.height(6.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Figure("Ativos", c.active.toString(), "de ${c.total}", TextPrimary, Modifier.weight(1f))
      Figure("Suspensos", c.suspended.toString(), null, if (c.suspended > 0) Warn else TextPrimary, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Figure("OS abertas", c.openWorkOrders.toString(), null, TextPrimary, Modifier.weight(1f))
      Figure("Assistência", c.openTickets.toString(), "pedidos abertos", TextPrimary, Modifier.weight(1f))
    }
    Spacer(Modifier.height(14.dp))
    Eyebrow("SMS")
    SmsRow("Hoje", sms.today)
    SmsRow("Este mês", sms.month)
  }
}

@Composable
private fun SmsRow(label: String, s: Dashboard.SmsCounts) {
  Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(label, color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
    Text("${s.sent} enviados · ${s.delivered} entregues", color = TextPrimary, style = MaterialTheme.typography.bodySmall)
    if (s.failed > 0) {
      Text(" · ${s.failed} falhados", color = Danger, style = MaterialTheme.typography.bodySmall)
    }
  }
}
