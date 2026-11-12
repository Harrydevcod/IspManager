package cv.novatech.ispm.sms.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The desktop's icons (lucide, ISC licence), copied from node_modules/lucide-react
 * so both screens draw the same glyphs: 24-unit grid, 2-unit round strokes.
 * Only what the app uses; add a glyph by pasting its path data from lucide.
 */
object Lucide {
  val LayoutDashboard = icon("layout-dashboard", rect(3, 3, 7, 9), rect(14, 3, 7, 5), rect(14, 12, 7, 9), rect(3, 16, 7, 5))
  val MapPin = icon(
    "map-pin",
    "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
    circle(12, 10, 3)
  )
  val MessageSquare = icon("message-square", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z")
  val History = icon("history", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2")
  val Settings = icon(
    "settings",
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    circle(12, 12, 3)
  )
  val RefreshCw = icon(
    "refresh-cw",
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"
  )
  val Sun = icon(
    "sun", circle(12, 12, 4), "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41",
    "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"
  )
  val Moon = icon("moon", "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")
  val Lock = icon("lock", rect(3, 11, 18, 11, r = 2), "M7 11V7a5 5 0 0 1 10 0v4")
  val QrCode = icon(
    "qr-code", rect(3, 3, 5, 5), rect(16, 3, 5, 5), rect(3, 16, 5, 5),
    "M21 16h-3a2 2 0 0 0-2 2v3", "M21 21v.01", "M12 7v3a2 2 0 0 1-2 2H7", "M3 12h.01", "M12 3h.01",
    "M12 16v.01", "M16 12h1", "M21 12v.01", "M12 21v-1"
  )
  val Check = icon("check", "M20 6 9 17l-5-5")
}

private fun rect(x: Int, y: Int, w: Int, h: Int, r: Int = 1) =
  "M${x + r} ${y}h${w - 2 * r}a$r $r 0 0 1 $r ${r}v${h - 2 * r}a$r $r 0 0 1 -$r ${r}h-${w - 2 * r}a$r $r 0 0 1 -$r -${r}v-${h - 2 * r}a$r $r 0 0 1 $r -${r}z"

private fun circle(cx: Int, cy: Int, r: Int) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 -${2 * r} 0"

private fun icon(name: String, vararg paths: String): ImageVector =
  ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
    paths.forEach {
      addPath(
        pathData = addPathNodes(it), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round
      )
    }
  }.build()
