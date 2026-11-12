package cv.novatech.ispm.sms.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import cv.novatech.ispm.sms.R

/** The launcher icon itself (scripts/make-icons.mjs), so the first screen is recognisably the app the owner tapped. */
@Composable
fun AppMark(size: Int = 72) {
  Box(Modifier.size(size.dp).clip(RoundedCornerShape((size / 4).dp)).background(Color(0xFF191B1F))) {
    Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, modifier = Modifier.fillMaxSize())
  }
}
