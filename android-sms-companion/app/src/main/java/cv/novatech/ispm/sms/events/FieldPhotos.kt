package cv.novatech.ispm.sms.events

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.ByteArrayOutputStream
import kotlin.math.max

/**
 * A camera photo made fit for the desktop: longest side 1600 px, JPEG 80
 * (~200 KB), upright. The desktop keeps it inside its SQLite file, so size matters.
 */
object FieldPhotos {
  private const val MAX_SIDE = 1600
  private const val QUALITY = 80

  /** Power-of-two decode step that keeps the longest side at or above [MAX_SIDE]. */
  fun sampleSize(width: Int, height: Int): Int {
    var sample = 1
    while (max(width, height) / (sample * 2) >= MAX_SIDE) sample *= 2
    return sample
  }

  fun compress(context: Context, uri: Uri): ByteArray? = runCatching {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0) return null
    val decoded = resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) })
    } ?: return null
    val rotation = resolver.openInputStream(uri)?.use {
      when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90f
        ExifInterface.ORIENTATION_ROTATE_180 -> 180f
        ExifInterface.ORIENTATION_ROTATE_270 -> 270f
        else -> 0f
      }
    } ?: 0f
    val scale = MAX_SIDE.toFloat() / max(decoded.width, decoded.height)
    val matrix = Matrix().apply {
      if (scale < 1f) postScale(scale, scale)
      postRotate(rotation)
    }
    val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    ByteArrayOutputStream().use { out ->
      upright.compress(Bitmap.CompressFormat.JPEG, QUALITY, out)
      out.toByteArray()
    }
  }.getOrNull()
}
