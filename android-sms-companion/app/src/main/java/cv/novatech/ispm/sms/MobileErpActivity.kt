package cv.novatech.ispm.sms

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/** The ERP is bundled locally; only its main frame can use the paired TLS client. */
class MobileErpActivity : Activity() {
  private var view: WebView? = null
  private var dispatcher: MobileBridgeDispatcher? = null
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private var allowMultipleFiles = false
  private var stoppedAt: Long? = null

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    val app = application as IspmSmsApp
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || app.pairingStore.desktopIdentity() == null ||
      runCatching { assets.open("ispm/index.html").close() }.isFailure) {
      setContentView(TextView(this).apply { text = "A ligação ao computador não está disponível. Confirme o acesso móvel nas definições do ISPM."; setPadding(32, 48, 32, 32) })
      return
    }
    val assetLoader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
    val web = WebView(this)
    view = web
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      // The chosen content URI is read by WebView only after validation below.
      allowContentAccess = true
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    }
    web.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        return !MobileAssetPolicy.allows(request.url.toString())
      }
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        if (MobileAssetPolicy.allows(uri.toString())) {
          assetLoader.shouldInterceptRequest(uri)?.let { return it }
        }
        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }
    }
    web.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        if (fileCallback != null || params.mode !in setOf(FileChooserParams.MODE_OPEN, FileChooserParams.MODE_OPEN_MULTIPLE)) return false
        return try {
          fileCallback = callback
          allowMultipleFiles = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
          startActivityForResult(params.createIntent(), FILE_REQUEST)
          true
        } catch (_: Exception) {
          fileCallback = null
          false
        }
      }
    }
    val native = MobileBridgeHandler(app.pairingStore.mobileHttpClient()::execute)
    val main = Handler(Looper.getMainLooper())
    val dispatch = MobileBridgeDispatcher(maxRequests = 4, process = native::handle) { runnable -> main.post(runnable) }
    dispatcher = dispatch
    WebViewCompat.addWebMessageListener(web, "ispmMobile", setOf(MobileBridgeHandler.ORIGIN)) { _, message, sourceOrigin, isMainFrame, reply ->
      val body = message.data ?: return@addWebMessageListener
      if (!dispatch.submit(sourceOrigin.toString(), isMainFrame, body) { response -> reply.postMessage(response) } &&
        sourceOrigin.toString() == MobileBridgeHandler.ORIGIN && isMainFrame) {
        val id = Regex("^\\{\"id\":\"([1-9][0-9]{0,15})\"").find(body.take(64))?.groupValues?.get(1)
        if (id != null) reply.postMessage("{\"id\":\"$id\",\"error\":true}")
      }
    }
    setContentView(web)
    web.loadUrl("${MobileBridgeHandler.ORIGIN}/assets/ispm/index.html")
  }

  override fun onStop() {
    super.onStop()
    stoppedAt = SystemClock.elapsedRealtime()
  }

  override fun onStart() {
    super.onStart()
    val previous = stoppedAt
    stoppedAt = null
    if (previous != null && MobileSessionTimeout.expired(previous, SystemClock.elapsedRealtime())) {
      view?.evaluateJavascript("sessionStorage.removeItem('ispm:auth-token'); location.reload();", null)
    }
  }

  @Deprecated("Android Activity result callback")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != FILE_REQUEST) return
    val callback = fileCallback ?: return
    fileCallback = null
    val multiple = allowMultipleFiles
    allowMultipleFiles = false
    val result = try {
      val uris = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
      if (uris == null || uris.isEmpty() || uris.size > (if (multiple) 10 else 1) || data == null || data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) null
      else if (uris.all { uri ->
        val provider = uri.authority?.let { packageManager.resolveContentProvider(it, 0) }
        val granted = checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED
        MobileFileSelectionPolicy.accepts(uri.scheme, uri.authority, provider?.applicationInfo?.uid, applicationInfo.uid, granted)
      }) uris else null
    } catch (_: Exception) { null }
    callback.onReceiveValue(result)
  }

  override fun onDestroy() {
    fileCallback?.onReceiveValue(null)
    fileCallback = null
    dispatcher?.close()
    dispatcher = null
    view?.apply { stopLoading(); loadUrl("about:blank"); destroy() }
    view = null
    super.onDestroy()
  }

  private companion object { const val FILE_REQUEST = 7194 }
}
