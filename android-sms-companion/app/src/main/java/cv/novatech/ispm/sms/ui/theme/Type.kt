package cv.novatech.ispm.sms.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import cv.novatech.ispm.sms.R

// The desktop's family (Inter), bundled: the app works offline. OFL, see third_party/Inter-OFL.txt.
val Inter = FontFamily(
  Font(R.font.inter_regular, FontWeight.Normal),
  Font(R.font.inter_medium, FontWeight.Medium),
  Font(R.font.inter_semibold, FontWeight.SemiBold),
  Font(R.font.inter_bold, FontWeight.Bold)
)

private fun style(size: Int, weight: FontWeight, line: Int, tracking: Double = 0.0, tabular: Boolean = false) = TextStyle(
  fontFamily = Inter, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = tracking.sp,
  fontFeatureSettings = if (tabular) "tnum" else null
)

// Product scale, ~1.2 between steps (12 · 13 · 15 · 17 · 20 · 28). Every figure is tabular.
// No uppercase tracked eyebrows: section names are sentence case, set by weight.
val IspmTypography = Typography(
  headlineLarge = style(28, FontWeight.SemiBold, 34, -0.6, tabular = true),
  headlineSmall = style(20, FontWeight.SemiBold, 26, -0.3, tabular = true),
  titleLarge = style(20, FontWeight.SemiBold, 26, -0.3),
  titleMedium = style(17, FontWeight.SemiBold, 22, -0.2),
  titleSmall = style(15, FontWeight.SemiBold, 20, tabular = true),
  bodyLarge = style(15, FontWeight.Normal, 22),
  bodyMedium = style(15, FontWeight.Normal, 21),
  bodySmall = style(13, FontWeight.Normal, 18),
  labelLarge = style(15, FontWeight.SemiBold, 20),
  labelMedium = style(13, FontWeight.Medium, 18, tabular = true),
  labelSmall = style(12, FontWeight.Medium, 16, tabular = true)
)
