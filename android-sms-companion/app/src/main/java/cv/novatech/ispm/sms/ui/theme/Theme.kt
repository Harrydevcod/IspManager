package cv.novatech.ispm.sms.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val DarkColors = darkColorScheme(
  primary = AccentBlue,
  onPrimary = TextPrimary,
  secondary = AccentOrange,
  background = Bg,
  onBackground = TextPrimary,
  surface = Surface,
  onSurface = TextPrimary,
  error = Danger
)

private val IspmShapes = Shapes(
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(14.dp),
  large = RoundedCornerShape(16.dp)
)

@Composable
fun IspmTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = DarkColors, typography = IspmTypography, shapes = IspmShapes, content = content)
}
