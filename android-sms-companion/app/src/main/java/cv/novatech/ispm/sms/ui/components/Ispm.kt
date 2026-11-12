package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.ui.theme.*

/** The desktop's button variants. A destructive action beside others is `CRITICAL`, never a ghost. */
enum class ButtonVariant { PRIMARY, SECONDARY, GHOST, CRITICAL }

@Composable
fun IspmButton(
  text: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  variant: ButtonVariant = ButtonVariant.SECONDARY,
  enabled: Boolean = true,
  icon: ImageVector? = null
) {
  val shape = MaterialTheme.shapes.small
  val padding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)
  val content: @Composable RowScope.() -> Unit = {
    if (icon != null) {
      Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
      Spacer(Modifier.width(8.dp))
    }
    Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
  when (variant) {
    ButtonVariant.PRIMARY -> Button(
      onClick, modifier, enabled, shape = shape, contentPadding = padding,
      colors = ButtonDefaults.buttonColors(
        containerColor = Accent, contentColor = OnAccent,
        disabledContainerColor = Surface3, disabledContentColor = TextMuted
      ),
      content = content
    )
    ButtonVariant.SECONDARY, ButtonVariant.CRITICAL -> OutlinedButton(
      onClick, modifier, enabled, shape = shape, contentPadding = padding,
      border = BorderStroke(1.dp, Border2),
      colors = ButtonDefaults.outlinedButtonColors(
        containerColor = Surface,
        contentColor = if (variant == ButtonVariant.CRITICAL) Danger else TextPrimary,
        disabledContentColor = TextMuted
      ),
      content = content
    )
    ButtonVariant.GHOST -> TextButton(
      onClick, modifier, enabled, shape = shape, contentPadding = padding,
      colors = ButtonDefaults.textButtonColors(contentColor = TextSecondary),
      content = content
    )
  }
}

/** The top of every tab: same size, same place, an optional line under it and actions on the right. */
@Composable
fun ScreenTitle(title: String, line: String? = null, lineColor: Color = TextMuted, actions: @Composable RowScope.() -> Unit = {}) {
  Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) {
      Text(title, color = TextPrimary, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (line != null) {
        Spacer(Modifier.height(2.dp))
        Text(line, color = lineColor, style = MaterialTheme.typography.bodySmall)
      }
    }
    actions()
  }
}

/** Sentence case, set by weight; the count reads as a quieter number beside it. */
@Composable
fun SectionHeader(title: String, count: Int? = null, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
  Row(modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(title, color = TextPrimary, style = MaterialTheme.typography.titleSmall)
    if (count != null) {
      Spacer(Modifier.width(6.dp))
      Text(count.toString(), color = TextMuted, style = MaterialTheme.typography.titleSmall)
    }
    Spacer(Modifier.weight(1f))
    trailing?.invoke()
  }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) = HorizontalDivider(modifier, thickness = 1.dp, color = BorderC)

@Composable
fun StatusDot(color: Color, size: Int = 8) = Box(Modifier.size(size.dp).clip(CircleShape).background(color))

/** A label on the left, its figure on the right, aligned on the digits. */
@Composable
fun LedgerRow(label: String, value: String, valueColor: Color = TextPrimary, detail: String? = null) {
  Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) {
      Text(label, color = TextSecondary, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (detail != null) Text(detail, color = TextMuted, style = MaterialTheme.typography.labelSmall)
    }
    Spacer(Modifier.width(12.dp))
    Text(value, color = valueColor, style = MaterialTheme.typography.titleSmall)
  }
}

/** Grouped rows, the platform's settings pattern: one rounded surface, hairlines between rows. */
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
  Column(
    modifier.fillMaxWidth()
      .clip(MaterialTheme.shapes.medium).background(Surface)
      .border(1.dp, BorderC, MaterialTheme.shapes.medium),
    content = content
  )
}

/** One row of a [Group]: title, an optional line under it, the control on the right. */
@Composable
fun GroupRow(
  title: String,
  detail: String? = null,
  detailColor: Color = TextMuted,
  onClick: (() -> Unit)? = null,
  trailing: @Composable (() -> Unit)? = null
) {
  Row(
    Modifier.fillMaxWidth()
      .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
      .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Column(Modifier.weight(1f)) {
      Text(title, color = TextPrimary, style = MaterialTheme.typography.bodyLarge)
      if (detail != null) Text(detail, color = detailColor, style = MaterialTheme.typography.bodySmall)
    }
    if (trailing != null) {
      Spacer(Modifier.width(12.dp))
      trailing()
    }
  }
}

/** Divider inside a [Group], inset to the text like the platform does. */
@Composable
fun GroupDivider() = Hairline(Modifier.padding(start = 16.dp))

/** Two to four mutually exclusive choices that fit on one line. */
@Composable
fun <T> SegmentedControl(options: List<T>, selected: T, label: (T) -> String, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).background(Surface3).padding(3.dp).selectableGroup(),
    horizontalArrangement = Arrangement.spacedBy(3.dp)
  ) {
    options.forEach { option ->
      val active = option == selected
      Box(
        Modifier.weight(1f).heightIn(min = 40.dp)
          .clip(RoundedCornerShape(8.dp))
          .background(if (active) Surface else Color.Transparent)
          .then(if (active) Modifier.border(1.dp, BorderC, RoundedCornerShape(8.dp)) else Modifier)
          .selectable(selected = active, role = Role.RadioButton, onClick = { onSelect(option) }),
        contentAlignment = Alignment.Center
      ) {
        Text(
          label(option), color = if (active) TextPrimary else TextSecondary,
          style = MaterialTheme.typography.labelMedium, maxLines = 1
        )
      }
    }
  }
}

/** Something that blocks the work, with the fix one tap away. Tinted, never a side stripe. */
@Composable
fun Banner(title: String, action: String, onClick: () -> Unit, tone: Color = Warn, toneBg: Color = WarnBg) {
  Row(
    Modifier.fillMaxWidth()
      .clip(MaterialTheme.shapes.small).background(toneBg)
      .clickable(onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 14.dp, vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Text(title, color = TextPrimary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    Spacer(Modifier.width(12.dp))
    Text(action, color = tone, style = MaterialTheme.typography.labelLarge)
  }
}
