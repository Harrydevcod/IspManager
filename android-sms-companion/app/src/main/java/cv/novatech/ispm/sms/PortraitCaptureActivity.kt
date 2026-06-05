package cv.novatech.ispm.sms

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * ZXing's default capture screen follows the sensor and flips to landscape on
 * launch. Pinning a dedicated subclass to portrait (via the manifest) keeps the
 * QR scanner upright, matching the rest of the single-orientation app.
 */
class PortraitCaptureActivity : CaptureActivity()
