package cv.novatech.ispm.sms.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.FieldRules
import cv.novatech.ispm.sms.dashboard.Freshness
import cv.novatech.ispm.sms.ui.components.rememberNow
import cv.novatech.ispm.sms.ui.dashboard.Card
import cv.novatech.ispm.sms.ui.dashboard.Eyebrow
import cv.novatech.ispm.sms.ui.theme.*

/**
 * Terreno: what to do away from the desk. Who to chase for money and which jobs
 * are open, each one a tap from the phone call, the SMS, WhatsApp or the map.
 * Read-only: nothing here changes the ISPM (that stays on the desktop).
 */
@Composable
fun FieldScreen(dashboard: Dashboard?, receivedAt: Long?, onOpen: (String) -> Unit) {
  val now = rememberNow()
  val freshness = DashboardRules.freshness(receivedAt, now)
  LazyColumn(
    Modifier.fillMaxSize().padding(horizontal = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(vertical = 16.dp)
  ) {
    item {
      Column {
        Text("Terreno", color = TextPrimary, style = MaterialTheme.typography.titleLarge)
        if (receivedAt != null) {
          val stale = freshness == Freshness.STALE
          Text(
            if (stale) "Dados de ${DashboardRules.ago(now - receivedAt)} — o PC não envia, confirme antes de cobrar"
            else "Atualizado ${DashboardRules.ago(now - receivedAt)}",
            color = if (stale) Warn else TextMuted, style = MaterialTheme.typography.bodySmall
          )
        }
      }
    }
    when {
      dashboard == null -> item { Note("À espera do primeiro resumo do ISPM no PC.") }
      !dashboard.hasFieldData -> item { Note("Atualize o ISPM no PC para ver a cobrança e as ordens de trabalho aqui.") }
      else -> {
        item { Eyebrow("Cobrar · ${dashboard.money.debtors.size}") }
        if (dashboard.money.debtors.isEmpty()) item { Note("Ninguém em atraso.") }
        items(dashboard.money.debtors, key = { "d:" + it.clientCode + it.clientName }) { DebtorRow(it, onOpen) }
        item { Spacer(Modifier.height(6.dp)); Eyebrow("Ordens de trabalho · ${dashboard.work.orders.size}") }
        if (dashboard.work.orders.isEmpty()) item { Note("Sem OS em aberto.") }
        items(dashboard.work.orders, key = { "o:${it.id}" }) { OrderRow(it, onOpen) }
        item { Spacer(Modifier.height(6.dp)); Eyebrow("Assistência · ${dashboard.work.tickets.size}") }
        if (dashboard.work.tickets.isEmpty()) item { Note("Sem pedidos abertos.") }
        items(dashboard.work.tickets, key = { "t:${it.id}" }) { TicketRow(it, onOpen) }
      }
    }
  }
}

@Composable
private fun Note(text: String) = Text(text, color = TextMuted, style = MaterialTheme.typography.bodySmall)

/** A row that opens to its actions on tap; one open at a time is enough on a phone. */
@Composable
private fun Expandable(header: @Composable () -> Unit, actions: @Composable ColumnScope.() -> Unit) {
  var open by remember { mutableStateOf(false) }
  Card(Modifier.animateContentSize().clickable { open = !open }) {
    header()
    if (open) {
      Spacer(Modifier.height(12.dp))
      actions()
    }
  }
}

@Composable
private fun DebtorRow(d: Dashboard.Debtor, onOpen: (String) -> Unit) = Expandable(
  header = {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text(d.clientName, color = TextPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
          "${d.daysOverdue} dias em atraso" + if (d.clientCode.isNotBlank()) " · ${d.clientCode}" else "",
          color = if (d.daysOverdue >= 30) Danger else TextMuted, style = MaterialTheme.typography.bodySmall
        )
      }
      Text(DashboardRules.formatCve(d.amountCve), color = TextPrimary, style = MaterialTheme.typography.titleSmall)
    }
  },
  actions = { ContactActions(d.phone, onOpen) }
)

@Composable
private fun OrderRow(o: Dashboard.WorkOrder, onOpen: (String) -> Unit) {
  val place = listOfNotNull(o.zone, o.island).filter { it.isNotBlank() }.joinToString(" · ")
  val maps = FieldRules.mapsUri(o.address, o.zone, o.island)
  Expandable(
    header = {
      Row(verticalAlignment = Alignment.CenterVertically) {
        PriorityDot(o.priority)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
          Text(o.title, color = TextPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(
            listOfNotNull(o.clientName ?: "Rede", place.ifBlank { null }, o.assignedTo?.let { "→ $it" }).joinToString(" · "),
            color = TextMuted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis
          )
        }
      }
    },
    actions = {
      o.address?.takeIf { it.isNotBlank() }?.let { Text(it, color = TextSecondary, style = MaterialTheme.typography.bodySmall) }
      Spacer(Modifier.height(8.dp))
      ContactActions(o.phone, onOpen, mapsUri = maps)
    }
  )
}

@Composable
private fun TicketRow(t: Dashboard.Ticket, onOpen: (String) -> Unit) = Expandable(
  header = {
    Row(verticalAlignment = Alignment.CenterVertically) {
      PriorityDot(t.priority)
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(t.subject, color = TextPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(t.clientName, color = TextMuted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  },
  actions = { ContactActions(t.phone, onOpen) }
)

@Composable
private fun PriorityDot(priority: String) {
  val c = when (priority) { "alta" -> Danger; "media" -> Warn; else -> TextMuted }
  Box(Modifier.size(8.dp).clip(CircleShape).background(c))
}

/** Call / SMS / WhatsApp (+ map). Without a valid number the contact buttons say why instead of failing. */
@Composable
private fun ContactActions(phone: String?, onOpen: (String) -> Unit, mapsUri: String? = null) {
  if (phone == null) {
    Text("Sem telefone válido na ficha", color = Warn, style = MaterialTheme.typography.bodySmall)
  }
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    if (phone != null) {
      Action("Ligar", Modifier.weight(1f)) { onOpen(FieldRules.dialUri(phone)) }
      Action("SMS", Modifier.weight(1f)) { onOpen(FieldRules.smsUri(phone)) }
      Action("WhatsApp", Modifier.weight(1f)) { onOpen(FieldRules.whatsappUrl(phone)) }
    }
    if (mapsUri != null) Action("Mapa", Modifier.weight(1f)) { onOpen(mapsUri) }
  }
}

@Composable
private fun Action(label: String, modifier: Modifier, onClick: () -> Unit) = OutlinedButton(
  onClick = onClick,
  modifier = modifier,
  shape = RoundedCornerShape(10.dp),
  contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp),
  colors = ButtonDefaults.outlinedButtonColors(contentColor = TextPrimary)
) { Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1) }
