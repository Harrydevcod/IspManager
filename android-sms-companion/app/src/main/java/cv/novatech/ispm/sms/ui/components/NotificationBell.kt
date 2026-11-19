package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.dashboard.DashboardRules
import cv.novatech.ispm.sms.state.Alert
import cv.novatech.ispm.sms.state.AlertAction
import cv.novatech.ispm.sms.state.AlertSeverity
import cv.novatech.ispm.sms.state.NotificationEntry
import cv.novatech.ispm.sms.state.NotificationFeed
import cv.novatech.ispm.sms.ui.theme.Accent
import cv.novatech.ispm.sms.ui.theme.AccentBg
import cv.novatech.ispm.sms.ui.theme.Danger
import cv.novatech.ispm.sms.ui.theme.Lucide
import cv.novatech.ispm.sms.ui.theme.OnAccent
import cv.novatech.ispm.sms.ui.theme.Surface
import cv.novatech.ispm.sms.ui.theme.TextMuted
import cv.novatech.ispm.sms.ui.theme.TextPrimary
import cv.novatech.ispm.sms.ui.theme.TextSecondary
import cv.novatech.ispm.sms.ui.theme.Warn
import kotlinx.coroutines.launch

/**
 * O sino, no topo de todos os ecrãs.
 *
 * Junta num sítio só o que estava espalhado — banners, cartão de estado, selo
 * do separador — e, por baixo, o histórico que é comum ao PC. O número é o que
 * ainda não foi visto; abrir o painel apaga-o, mas cada entrada continua por
 * ler até ser tocada.
 */

@Composable
private fun severityColorOf(severity: AlertSeverity) = when (severity) {
  AlertSeverity.Danger -> Danger
  AlertSeverity.Warn -> Warn
  AlertSeverity.Info -> Accent
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationBell(
  alerts: List<Alert>,
  entries: List<NotificationEntry> = emptyList(),
  seenAt: Long? = null,
  now: Long = System.currentTimeMillis(),
  onAction: (AlertAction) -> Unit = {},
  onEntry: (NotificationEntry) -> Unit = {},
  onMarkAllRead: () -> Unit = {},
  onOpened: () -> Unit = {},
  onResend: (String) -> Unit = {}
) {
  var open by remember { mutableStateOf(false) }
  val sheetState = rememberModalBottomSheetState()
  val scope = rememberCoroutineScope()
  val count = alerts.size + NotificationFeed.unseenCount(entries, seenAt)
  val label = if (count > 0) "Notificações, $count" else "Notificações"

  IconButton(
    onClick = { open = true; onOpened() },
    modifier = Modifier.size(48.dp).semantics { contentDescription = label }
  ) {
    val glyph: @Composable () -> Unit = { Icon(Lucide.Bell, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(22.dp)) }
    if (count > 0) {
      val tint = alerts.minByOrNull { it.severity.ordinal }?.let { severityColorOf(it.severity) } ?: Accent
      BadgedBox(badge = { Badge(containerColor = tint, contentColor = OnAccent) { Text(if (count > 9) "9+" else count.toString()) } }) { glyph() }
    } else {
      glyph()
    }
  }

  if (open) {
    // Fecha primeiro e só depois age: a ação muda de separador por baixo do painel.
    fun closeThen(run: () -> Unit) {
      scope.launch { sheetState.hide() }.invokeOnCompletion { open = false; run() }
    }
    ModalBottomSheet(onDismissRequest = { open = false }, sheetState = sheetState, containerColor = Surface) {
      NotificationList(
        alerts = alerts,
        entries = entries,
        now = now,
        onAction = { action -> closeThen { onAction(action) } },
        onEntry = { entry -> closeThen { onEntry(entry) } },
        onMarkAllRead = onMarkAllRead,
        onResend = onResend
      )
    }
  }
}

/**
 * O conteúdo do painel, à parte do sheet: o Paparazzi não desenha o
 * `ModalBottomSheet`, e é isto que vale a pena fotografar.
 */
@Composable
fun NotificationList(
  alerts: List<Alert>,
  entries: List<NotificationEntry> = emptyList(),
  now: Long = System.currentTimeMillis(),
  onAction: (AlertAction) -> Unit = {},
  onEntry: (NotificationEntry) -> Unit = {},
  onMarkAllRead: () -> Unit = {},
  onResend: (String) -> Unit = {}
) {
  val unread = entries.count { !it.read }
  Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
    ScreenTitle("Notificações") {
      if (unread > 0) IspmButton("Marcar como lidas", onMarkAllRead, variant = ButtonVariant.GHOST)
    }

    if (alerts.isEmpty() && entries.isEmpty()) {
      Column(
        Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
      ) {
        Icon(Lucide.Bell, contentDescription = null, tint = TextMuted, modifier = Modifier.size(28.dp))
        Spacer(Modifier.height(8.dp))
        Text("Tudo em ordem", color = TextMuted, style = MaterialTheme.typography.bodyMedium)
      }
      return@Column
    }

    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp)) {
      if (alerts.isNotEmpty()) {
        item { SectionHeader("Agora") }
        items(alerts, key = { it.key }) { alert -> AlertRow(alert, onAction) }
      }
      if (entries.isNotEmpty()) {
        item { SectionHeader("Anteriores") }
        items(entries, key = { it.uid }) { entry -> EntryRow(entry, now, onEntry, onResend) }
      }
    }
  }
}

@Composable
private fun AlertRow(alert: Alert, onAction: (AlertAction) -> Unit) {
  Column {
    Row(
      Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 10.dp),
      verticalAlignment = Alignment.Top
    ) {
      StatusDot(severityColorOf(alert.severity))
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(alert.title, color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
        if (alert.line != null) {
          Spacer(Modifier.height(2.dp))
          Text(alert.line, color = TextSecondary, style = MaterialTheme.typography.bodySmall)
        }
        // Com letra grande os botões não cabem ao lado: ficam por baixo, à direita.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
          if (alert.secondaryLabel != null && alert.secondary != null) {
            IspmButton(alert.secondaryLabel, { onAction(alert.secondary) }, variant = ButtonVariant.GHOST)
            Spacer(Modifier.width(4.dp))
          }
          if (alert.actionLabel != null) {
            IspmButton(
              alert.actionLabel,
              { onAction(alert.action) },
              variant = if (alert.action == AlertAction.Unpair) ButtonVariant.CRITICAL else ButtonVariant.GHOST
            )
          }
        }
      }
    }
    Hairline()
  }
}

@Composable
private fun EntryRow(entry: NotificationEntry, now: Long, onEntry: (NotificationEntry) -> Unit, onResend: (String) -> Unit) {
  Column(
    Modifier
      .fillMaxWidth()
      .background(if (entry.read) Surface else AccentBg)
      .clickable { onEntry(entry) }
  ) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 10.dp, horizontal = 8.dp), verticalAlignment = Alignment.Top) {
      StatusDot(if (entry.read) TextMuted else severityDotOf(entry.severity))
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(
          entry.title,
          color = if (entry.read) TextSecondary else TextPrimary,
          style = if (entry.read) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.titleSmall
        )
        if (entry.text != null) {
          Spacer(Modifier.height(2.dp))
          Text(entry.text, color = TextMuted, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(2.dp))
        Text(DashboardRules.ago(now - entry.at), color = TextMuted, style = MaterialTheme.typography.labelSmall)
        if (entry.kind == "sms_failed" && entry.requestId != null) {
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            IspmButton("Reenviar", { onResend(entry.requestId) }, variant = ButtonVariant.GHOST)
          }
        }
      }
    }
    Hairline()
  }
}

@Composable
private fun severityDotOf(severity: String) = when (severity) {
  "danger" -> Danger
  "warn" -> Warn
  else -> Accent
}
