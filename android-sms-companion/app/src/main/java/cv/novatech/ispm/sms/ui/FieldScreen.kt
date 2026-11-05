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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.ClientRules
import cv.novatech.ispm.sms.dashboard.Dashboard
import cv.novatech.ispm.sms.events.FieldEvent
import org.json.JSONObject
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.dashboard.FieldRules
import cv.novatech.ispm.sms.dashboard.Freshness
import cv.novatech.ispm.sms.ui.components.rememberNow
import cv.novatech.ispm.sms.ui.dashboard.Card
import cv.novatech.ispm.sms.ui.dashboard.Eyebrow
import cv.novatech.ispm.sms.ui.theme.*

/**
 * Terreno: what to do away from the desk. Who to chase for money and which jobs
 * are open, each one a tap from the phone call, the SMS, WhatsApp or the map, and
 * any client found by name, code or number, offline.
 * What is done here (an order closed, cash received) waits on the phone until
 * the PC pulls it; the screen says so instead of pretending the ISPM changed.
 */
@Composable
fun FieldScreen(
  dashboard: Dashboard?,
  receivedAt: Long?,
  onOpen: (String) -> Unit,
  pendingEvents: List<FieldEvent> = emptyList(),
  onFieldEvent: (kind: String, payload: JSONObject, photos: List<ByteArray>) -> Unit = { _, _, _ -> }
) {
  val closedOrders = remember(pendingEvents) {
    pendingEvents.filter { it.kind == FieldEvent.WORK_ORDER_DONE }.map { it.payload.optLong("workOrderId") }.toSet()
  }
  val receivedFrom = remember(pendingEvents) {
    pendingEvents.filter { it.kind == FieldEvent.RECEIPT_PROPOSAL }
      .groupBy { it.payload.optString("clientCode") }
      .mapValues { (_, es) -> es.sumOf { it.payload.optLong("amountCve") } }
  }
  var completing by remember { mutableStateOf<Dashboard.WorkOrder?>(null) }
  var receiving by remember { mutableStateOf<Dashboard.Debtor?>(null) }
  completing?.let { order ->
    CompleteOrderSheet(order, onDismiss = { completing = null }) { notes, photos, location ->
      val payload = JSONObject().put("workOrderId", order.id).put("notes", notes)
      location?.let { (lat, lon) -> payload.put("lat", lat).put("lon", lon) }
      onFieldEvent(FieldEvent.WORK_ORDER_DONE, payload, photos)
      completing = null
    }
  }
  receiving?.let { debtor ->
    ReceiptSheet(debtor, onDismiss = { receiving = null }) { amount, method, note ->
      val payload = JSONObject().put("clientCode", debtor.clientCode).put("amountCve", amount).put("method", method)
      if (note.isNotBlank()) payload.put("note", note)
      onFieldEvent(FieldEvent.RECEIPT_PROPOSAL, payload, emptyList())
      receiving = null
    }
  }
  val now = rememberNow()
  val freshness = DashboardRules.freshness(receivedAt, now)
  var query by rememberSaveable { mutableStateOf("") }
  val found = remember(query, dashboard) { ClientRules.search(dashboard?.clients.orEmpty(), query) }
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
    if (!dashboard?.clients.isNullOrEmpty()) {
      item {
        OutlinedTextField(
          value = query, onValueChange = { query = it },
          placeholder = { Text("Procurar cliente: nome, código ou número", color = TextMuted) },
          singleLine = true, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
          colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = TextPrimary, unfocusedTextColor = TextPrimary,
            focusedBorderColor = AccentBlue, unfocusedBorderColor = BorderC, cursorColor = AccentBlue
          )
        )
      }
    }
    when {
      dashboard == null -> item { Note("À espera do primeiro resumo do ISPM no PC.") }
      query.isNotBlank() -> {
        item { Eyebrow("Clientes · ${found.size}") }
        if (found.isEmpty()) item { Note("Nenhum cliente com \"${query.trim()}\".") }
        items(found, key = { "c:" + it.code + it.name }) { ClientRow(it, onOpen) }
      }
      !dashboard.hasFieldData -> item { Note("Atualize o ISPM no PC para ver a cobrança e as ordens de trabalho aqui.") }
      else -> {
        item { Eyebrow("Cobrar · ${dashboard.money.debtors.size}") }
        if (dashboard.money.debtors.isEmpty()) item { Note("Ninguém em atraso.") }
        items(dashboard.money.debtors, key = { "d:" + it.clientCode + it.clientName }) {
          DebtorRow(it, onOpen, receivedFrom[it.clientCode], onReceive = { receiving = it })
        }
        item { Spacer(Modifier.height(6.dp)); Eyebrow("Ordens de trabalho · ${dashboard.work.orders.size}") }
        if (dashboard.work.orders.isEmpty()) item { Note("Sem OS em aberto.") }
        items(dashboard.work.orders, key = { "o:${it.id}" }) {
          OrderRow(it, onOpen, closed = it.id in closedOrders, onComplete = { completing = it })
        }
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
private fun DebtorRow(d: Dashboard.Debtor, onOpen: (String) -> Unit, received: Long?, onReceive: () -> Unit) = Expandable(
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
    if (received != null) {
      Text("Recebido ${DashboardRules.formatCve(received)} · à espera de confirmação no PC", color = Success, style = MaterialTheme.typography.bodySmall)
    }
  },
  actions = {
    ContactActions(d.phone, onOpen)
    if (d.clientCode.isNotBlank()) {
      Spacer(Modifier.height(8.dp))
      Action("Recebi em mão", Modifier.fillMaxWidth(), onReceive)
    }
    val link = d.paymentLink
    val amount = d.paymentLinkAmountCve
    if (d.phone != null && link != null && amount != null) {
      Spacer(Modifier.height(10.dp))
      Text("Link de pagamento · ${DashboardRules.formatCve(amount)}", color = TextSecondary, style = MaterialTheme.typography.bodySmall)
      Spacer(Modifier.height(6.dp))
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Action("Enviar por WhatsApp", Modifier.weight(1f)) {
          onOpen(FieldRules.whatsappUrl(d.phone, FieldRules.paymentLinkMessage(amount, link, forSms = false)))
        }
        Action("Enviar por SMS", Modifier.weight(1f)) {
          onOpen(FieldRules.smsUri(d.phone, FieldRules.paymentLinkMessage(amount, link, forSms = true)))
        }
      }
    }
  }
)

@Composable
private fun ClientRow(c: Dashboard.Client, onOpen: (String) -> Unit) {
  val place = listOfNotNull(c.zone, c.island).filter { it.isNotBlank() }.joinToString(" · ")
  val status = when (c.status) { "suspended" -> "Suspenso"; "active" -> "Ativo"; else -> c.status }
  Expandable(
    header = {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(c.name, color = TextPrimary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(
            listOf(c.code, status, place).filter { it.isNotBlank() }.joinToString(" · "),
            color = if (c.status == "suspended") Warn else TextMuted,
            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis
          )
        }
        if (c.overdueCve > 0) Text(DashboardRules.formatCve(c.overdueCve), color = Danger, style = MaterialTheme.typography.titleSmall)
      }
    },
    actions = {
      val facts = listOfNotNull(
        c.plan?.let { "Plano $it" },
        if (c.overdueCve > 0) "Deve ${DashboardRules.formatCve(c.overdueCve)} vencidos" else "Sem dívida vencida",
        c.lastPaymentAt?.let { "Último pagamento $it" } ?: "Sem pagamentos registados"
      )
      facts.forEach { Text(it, color = TextSecondary, style = MaterialTheme.typography.bodySmall) }
      Spacer(Modifier.height(8.dp))
      ContactActions(c.phone, onOpen, mapsUri = FieldRules.mapsUri(null, c.zone, c.island))
    }
  )
}

@Composable
private fun OrderRow(o: Dashboard.WorkOrder, onOpen: (String) -> Unit, closed: Boolean, onComplete: () -> Unit) {
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
          if (closed) Text("Concluída · à espera do PC", color = Success, style = MaterialTheme.typography.bodySmall)
        }
      }
    },
    actions = {
      o.address?.takeIf { it.isNotBlank() }?.let { Text(it, color = TextSecondary, style = MaterialTheme.typography.bodySmall) }
      Spacer(Modifier.height(8.dp))
      ContactActions(o.phone, onOpen, mapsUri = maps)
      if (!closed) {
        Spacer(Modifier.height(8.dp))
        Action("Concluir OS", Modifier.fillMaxWidth(), onComplete)
      }
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
