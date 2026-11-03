package cv.novatech.ispm.sms.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.Freshness
import cv.novatech.ispm.sms.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Painel: a read-only glance at the operation, pushed by the desktop. Ordered by
 * what the owner checks first — is anything on fire, is money coming in, is the
 * network up, then the day-to-day counts.
 */
@Composable
fun DashboardScreen(dashboard: Dashboard?, receivedAt: Long?) {
  // Re-render every 30 s so "há N min" and the stale state move on their own.
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) { delay(30_000); now = System.currentTimeMillis() }
  }
  val freshness = DashboardRules.freshness(receivedAt, now)

  if (dashboard == null || freshness == Freshness.NONE) {
    WaitingForDesktop()
    return
  }

  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item { Header(dashboard.companyName, receivedAt!!, now, freshness) }
    item { OperationCard(dashboard.operation) }
    item { MoneyCard(dashboard.money) }
    item { NetworkCard(dashboard.network) }
    item { CustomersCard(dashboard.customers, dashboard.sms) }
  }
}

@Composable
private fun WaitingForDesktop() {
  Column(
    Modifier.fillMaxSize().padding(32.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Text("À espera do desktop", color = TextPrimary, style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(6.dp))
    Text(
      "O ISPM no PC envia o resumo de 5 em 5 minutos quando está ligado e na mesma rede.",
      color = TextMuted, style = MaterialTheme.typography.bodySmall
    )
  }
}

@Composable
private fun Header(company: String, receivedAt: Long, now: Long, freshness: Freshness) {
  val stale = freshness == Freshness.STALE
  Column {
    Text(company, color = TextPrimary, style = MaterialTheme.typography.titleLarge)
    Spacer(Modifier.height(2.dp))
    Text(
      if (stale) "O desktop não envia ${DashboardRules.ago(now - receivedAt)} — PC desligado ou fora da rede?"
      else "Atualizado ${DashboardRules.ago(now - receivedAt)}",
      color = if (stale) Warn else TextMuted,
      style = MaterialTheme.typography.bodySmall
    )
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
private fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Column(
    modifier.fillMaxWidth()
      .clip(RoundedCornerShape(16.dp)).background(Surface)
      .border(1.dp, BorderC, RoundedCornerShape(16.dp))
      .padding(16.dp),
    content = content
  )
}

@Composable
private fun Eyebrow(text: String) {
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
    n.downNow.forEach { d ->
      Text("• ${d.name}", color = TextSecondary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
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
