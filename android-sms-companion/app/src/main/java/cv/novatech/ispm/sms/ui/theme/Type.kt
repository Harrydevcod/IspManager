package cv.novatech.ispm.sms.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Inter can be bundled into res/font later; system default keeps the build asset-free.
private val Sans = FontFamily.Default

val IspmTypography = Typography(
  titleLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = (-0.2).sp),
  titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, letterSpacing = (-0.1).sp),
  bodyMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 14.sp),
  bodySmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 12.sp),
  labelSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.8.sp)
)
