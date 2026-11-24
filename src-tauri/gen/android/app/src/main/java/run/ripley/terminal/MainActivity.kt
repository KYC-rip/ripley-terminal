package run.ripley.terminal

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.net.InetAddress
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  companion object {
    init {
      // Load the Rust JNI library before onCreate calls nativeSetLaunchSoloApp/nativeDeepLink
      // (WryActivity only triggers Rust's static init inside super.onCreate).
      System.loadLibrary("ripley_terminal_lib")
    }
  }

  private external fun nativeLock()
  private external fun nativeBackgroundLock()
  private external fun nativeResume()
  private external fun nativeNetworkChanged()
  private external fun nativeSetLaunchSoloApp(appPath: String)
  private external fun nativeDeepLink(uri: String)
  private external fun nativeBrowserEvent(source: String, message: String)
  private external fun nativeXappBridge(id: Long, request: String)

  @Volatile var suppressNextAutoLock: Boolean = false
  private var web: WebView? = null
  private var embedWeb: WebView? = null
  private var xappWeb: WebView? = null
  private var insetTop = 0
  private var insetBottom = 0
  private var insetLeft = 0
  private var insetRight = 0
  private val handler = Handler(Looper.getMainLooper())
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var hasSeenNetwork = false
  private var pendingCameraRequest: PermissionRequest? = null

  private val cameraPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    val req = pendingCameraRequest
    pendingCameraRequest = null
    if (req != null) {
      if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else req.deny()
    }
  }

  /** Re-push safe-area CSS tokens and gesture-nav flag while the ROS bundle boots. */
  private val pump = object : Runnable {
    override fun run() { pushInsets(); handler.postDelayed(this, 700) }
  }

  fun setSecureScreen(enabled: Boolean) {
    runOnUiThread {
      if (enabled) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      if (Build.VERSION.SDK_INT >= 33) {
        setRecentsScreenshotEnabled(!enabled)
      }
    }
  }

  fun setSystemBars(light: Boolean) {
    runOnUiThread {
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = light
        isAppearanceLightNavigationBars = light
      }
    }
  }

  fun applyWebViewProxy(proxyUrl: String?, onDone: (Boolean) -> Unit) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      onDone(false)
      return
    }
    val executor = ContextCompat.getMainExecutor(this)
    if (proxyUrl.isNullOrBlank()) {
      ProxyController.getInstance().clearProxyOverride(executor) { onDone(true) }
      return
    }
    try {
      val config = ProxyConfig.Builder()
        .addProxyRule(proxyUrl)
        .addBypassRule("*.localhost")
        .addBypassRule("localhost")
        .addBypassRule("127.0.0.1")
        .addBypassRule("[::1]")
        .build()
      ProxyController.getInstance().setProxyOverride(config, executor) { onDone(true) }
    } catch (_: Exception) {
      onDone(false)
    }
  }

  private fun isSafeBrowserUrl(raw: String, allowOnion: Boolean): Boolean {
    val u = try { Uri.parse(raw) } catch (_: Exception) { return false }
    val scheme = u.scheme?.lowercase() ?: return false
    if (scheme != "https" && scheme != "http") return false
    if (u.userInfo != null) return false
    val host = u.host?.lowercase()?.trim('[', ']') ?: return false
    if (host.isEmpty()) return false
    if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        host.endsWith(".internal") || host.endsWith(".lan")) return false
    if (host.endsWith(".onion")) return allowOnion
    if (scheme != "https") return false
    // Reject decimal/hex/octal integer IP literals (e.g. 2130706433, 0x7f000001)
    if (host.all { it.isDigit() } || host.startsWith("0x")) return false
    // Reject private/loopback IPv4 & IPv6 literals (including ::ffff:127.0.0.1 mapped forms)
    val looksLikeIp = host.contains(':') || host.split('.').all { p -> p.isNotEmpty() && p.all { it.isDigit() } }
    if (looksLikeIp) {
      try {
        val addr = InetAddress.getByName(host)
        if (addr.isAnyLocalAddress || addr.isLoopbackAddress || addr.isLinkLocalAddress ||
            addr.isSiteLocalAddress || addr.isMulticastAddress) {
          return false
        }
        val bytes = addr.address
        // Block CGNAT 100.64.0.0/10 and IPv6 ULA fc00::/7
        if (bytes.size == 4 && (bytes[0].toInt() and 0xFF) == 100 && ((bytes[1].toInt() and 0xC0) == 64)) {
          return false
        }
        if (bytes.size == 16 && ((bytes[0].toInt() and 0xFE) == 0xFC)) {
          return false
        }
      } catch (_: Exception) {
        return false
      }
    }
    return true
  }

  private fun isWalletScheme(raw: String): Boolean {
    val lower = raw.trim().lowercase()
    return lower.startsWith("monero:") || lower.startsWith("bitcoin:") ||
      lower.startsWith("solana:") || lower.startsWith("ethereum:") ||
      lower.startsWith("xmr402:") || lower.startsWith("ripley:") ||
      lower.startsWith("monero-signin:")
  }

  @SuppressLint("SetJavaScriptEnabled")
  fun embedOpen(url: String, x: Double, y: Double, w: Double, h: Double, bg: String?, zoom: Double?, allowOnion: Boolean, onDone: (Result<Unit>) -> Unit) {
    if (!isSafeBrowserUrl(url, allowOnion)) {
      onDone(Result.failure(IllegalArgumentException("Blocked URL for embedded browser")))
      return
    }
    runOnUiThread {
      try {
        val root = findViewById<FrameLayout>(android.R.id.content)
        embedWeb?.let { old ->
          (old.parent as? ViewGroup)?.removeView(old)
          old.destroy()
        }
        val child = WebView(this).apply {
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = true
          settings.allowFileAccess = false
          settings.allowContentAccess = false
          settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
          settings.useWideViewPort = true
          settings.loadWithOverviewMode = true
          settings.setSupportMultipleWindows(false)
          if (zoom != null && zoom > 0.2 && zoom <= 3.0) {
            settings.textZoom = (zoom * 100.0).toInt().coerceIn(50, 250)
          }
          if (!bg.isNullOrBlank()) {
            val rgb = bg.split(",").mapNotNull { it.trim().toIntOrNull() }
            if (rgb.size >= 3) {
              setBackgroundColor(Color.rgb(rgb[0].coerceIn(0, 255), rgb[1].coerceIn(0, 255), rgb[2].coerceIn(0, 255)))
            }
          }
          webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, u: String?, favicon: android.graphics.Bitmap?) {
              if (!u.isNullOrBlank()) nativeBrowserEvent("BROWSER_LOAD", "start|$u")
            }
            override fun onPageFinished(view: WebView?, u: String?) {
              if (!u.isNullOrBlank()) nativeBrowserEvent("BROWSER_LOAD", "end|$u")
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
              val target = request?.url?.toString() ?: return true
              if (isWalletScheme(target)) {
                if (request.hasGesture()) {
                  nativeBrowserEvent("BROWSER_URI", target)
                }
                return true
              }
              return !isSafeBrowserUrl(target, allowOnion)
            }
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
              val target = request?.url?.toString() ?: return null
              val lower = target.lowercase()
              if (lower.startsWith("data:") || lower.startsWith("blob:")) return null
              if (!isSafeBrowserUrl(target, allowOnion)) {
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
              }
              return null
            }
          }
        }
        val d = resources.displayMetrics.density
        val lp = FrameLayout.LayoutParams(
          (w * d).toInt().coerceAtLeast(1),
          (h * d).toInt().coerceAtLeast(1)
        ).apply {
          leftMargin = (x * d).toInt().coerceAtLeast(0)
          topMargin = (y * d).toInt().coerceAtLeast(0)
        }
        root.addView(child, lp)
        embedWeb = child
        child.loadUrl(url)
        onDone(Result.success(Unit))
      } catch (e: Exception) {
        onDone(Result.failure(e))
      }
    }
  }

  fun embedBounds(x: Double, y: Double, w: Double, h: Double) {
    runOnUiThread {
      val child = embedWeb ?: return@runOnUiThread
      val d = resources.displayMetrics.density
      val lp = (child.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
      lp.width = (w * d).toInt().coerceAtLeast(1)
      lp.height = (h * d).toInt().coerceAtLeast(1)
      lp.leftMargin = (x * d).toInt().coerceAtLeast(0)
      lp.topMargin = (y * d).toInt().coerceAtLeast(0)
      child.layoutParams = lp
    }
  }

  fun embedNavigate(url: String, allowOnion: Boolean, onDone: (Result<Unit>) -> Unit) {
    if (!isSafeBrowserUrl(url, allowOnion)) {
      onDone(Result.failure(IllegalArgumentException("Blocked URL for embedded browser")))
      return
    }
    runOnUiThread {
      val child = embedWeb
      if (child == null) {
        onDone(Result.failure(IllegalStateException("Embedded browser not open")))
      } else {
        child.loadUrl(url)
        onDone(Result.success(Unit))
      }
    }
  }

  fun embedVisible(visible: Boolean) {
    runOnUiThread {
      embedWeb?.visibility = if (visible) View.VISIBLE else View.GONE
    }
  }

  fun embedZoom(zoom: Double) {
    runOnUiThread {
      embedWeb?.settings?.textZoom = (zoom * 100.0).toInt().coerceIn(50, 250)
    }
  }

  fun embedClose() {
    runOnUiThread {
      embedWeb?.let { child ->
        (child.parent as? ViewGroup)?.removeView(child)
        child.destroy()
      }
      embedWeb = null
    }
  }

  // ── Built-in X App Overlay WebView (independent from Browser's embedWeb) ──

  private fun isXHost(host: String): Boolean {
    val h = host.trimEnd('.').lowercase()
    return h == "x.com" || h == "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com")
  }

  private fun isXTopLevelHost(host: String): Boolean {
    val h = host.trimEnd('.').lowercase()
    return isXHost(h) || h == "twimg.com" || h.endsWith(".twimg.com") ||
      h == "accounts.google.com" || h == "appleid.apple.com"
  }

  private fun isHttpsXUrl(raw: String?): Boolean {
    if (raw.isNullOrBlank()) return false
    val u = try { Uri.parse(raw) } catch (_: Exception) { return false }
    return u.scheme?.lowercase() == "https" && u.userInfo == null && u.host?.let { isXHost(it) } == true
  }

  private inner class XappJsBridge {
    @JavascriptInterface
    fun post(idStr: String, request: String) {
      val callId = idStr.toLongOrNull() ?: return
      if (request.length > 16384) return
      runOnUiThread {
        val currentUrl = xappWeb?.url
        if (isHttpsXUrl(currentUrl)) {
          nativeXappBridge(callId, request)
        }
      }
    }
  }

  private val xappBridgeShim = """
    (function(){
      if (window !== window.top || window.__ripleyXBridgeReady) return;
      window.__ripleyXBridgeReady = true;
      var nextId = 1, pending = new Map();
      window.__ripleyXBridgeDeliver = function(id, answer) {
        var entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.t);
        entry.resolve(answer);
      };
      var inv = function(cmd, args) {
        if (cmd !== 'xapp_bridge') return Promise.reject(new Error('not allowed'));
        if (!window.__RipleyXBridge || typeof window.__RipleyXBridge.post !== 'function') {
          return Promise.reject(new Error('bridge unavailable'));
        }
        var req = args && typeof args.request === 'string' ? args.request : '';
        if (req.length > 16384) return Promise.reject(new Error('request too large'));
        var id = nextId++;
        return new Promise(function(resolve, reject) {
          var t = setTimeout(function() { pending.delete(id); reject(new Error('RipleyOS didn’t answer')); }, 20000);
          pending.set(id, { resolve: resolve, reject: reject, t: t });
          try { window.__RipleyXBridge.post(String(id), req); }
          catch (e) { pending.delete(id); clearTimeout(t); reject(e); }
        });
      };
      window.__TAURI_INTERNALS__ = { invoke: inv };
    })();
  """.trimIndent()

  @SuppressLint("SetJavaScriptEnabled")
  fun xappOpen(
    url: String,
    script: String?,
    x: Double,
    y: Double,
    w: Double,
    h: Double,
    bg: String?,
    zoom: Double?,
    onDone: (Result<Unit>) -> Unit
  ) {
    if (!isHttpsXUrl(url)) {
      onDone(Result.failure(IllegalArgumentException("The X app only opens x.com.")))
      return
    }
    runOnUiThread {
      try {
        val root = findViewById<FrameLayout>(android.R.id.content)
        xappWeb?.let { old ->
          (old.parent as? ViewGroup)?.removeView(old)
          old.destroy()
        }
        val child = WebView(this).apply {
          settings.javaScriptEnabled = true
          settings.domStorageEnabled = true
          settings.databaseEnabled = true
          settings.allowFileAccess = false
          settings.allowContentAccess = false
          settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
          settings.useWideViewPort = true
          settings.loadWithOverviewMode = true
          settings.mediaPlaybackRequiresUserGesture = false
          settings.setSupportMultipleWindows(true)
          if (zoom != null && zoom > 0.2 && zoom <= 3.0) {
            settings.textZoom = (zoom * 100.0).toInt().coerceIn(50, 250)
          }
          if (!bg.isNullOrBlank()) {
            val rgb = bg.split(",").mapNotNull { it.trim().toIntOrNull() }
            if (rgb.size >= 3) {
              setBackgroundColor(Color.rgb(rgb[0].coerceIn(0, 255), rgb[1].coerceIn(0, 255), rgb[2].coerceIn(0, 255)))
            }
          }
          CookieManager.getInstance().setAcceptCookie(true)
          CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
          addJavascriptInterface(XappJsBridge(), "__RipleyXBridge")

          val docStartScript = if (!script.isNullOrBlank()) {
            "$xappBridgeShim\n$script"
          } else {
            xappBridgeShim
          }
          if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
              this,
              docStartScript,
              setOf("https://x.com", "https://*.x.com", "https://twitter.com", "https://*.twitter.com")
            )
          }

          setDownloadListener { _, _, _, _, _ ->
            nativeBrowserEvent("XAPP_NOTE", "download")
          }

          webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
              if (view == null) return false
              val extra = view.hitTestResult.extra
              if (!extra.isNullOrBlank()) {
                val u = try { Uri.parse(extra) } catch (_: Exception) { null }
                val scheme = u?.scheme?.lowercase()
                val host = u?.host?.lowercase() ?: ""
                if (scheme == "https" && isXHost(host)) {
                  view.loadUrl(extra)
                } else if (scheme == "http" && isXHost(host)) {
                  view.loadUrl(extra.replaceFirst("http://", "https://", ignoreCase = true))
                } else if (scheme == "https" || scheme == "http") {
                  nativeBrowserEvent("XAPP_EXTERNAL", extra)
                }
                return true
              }
              return false
            }
          }

          webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, u: String?, favicon: android.graphics.Bitmap?) {
              if (!u.isNullOrBlank()) nativeBrowserEvent("XAPP_LOAD", "start|$u")
            }
            override fun onPageFinished(view: WebView?, u: String?) {
              if (!u.isNullOrBlank()) nativeBrowserEvent("XAPP_LOAD", "end|$u")
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
              val target = request?.url?.toString() ?: return true
              if (isWalletScheme(target)) {
                if (request.hasGesture()) {
                  nativeBrowserEvent("XAPP_URI", target)
                }
                return true
              }
              val u = request.url ?: return true
              val scheme = u.scheme?.lowercase() ?: return true
              val host = u.host?.lowercase() ?: ""
              if (scheme == "http" && isXHost(host)) {
                view?.loadUrl(target.replaceFirst("http://", "https://", ignoreCase = true))
                return true
              }
              if (scheme == "https" && isXTopLevelHost(host)) {
                return false
              }
              if (scheme == "https" || scheme == "http") {
                if (request.isForMainFrame) {
                  nativeBrowserEvent("XAPP_EXTERNAL", target)
                  return true
                }
                return !isSafeBrowserUrl(target, false)
              }
              return true
            }
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
              val target = request?.url?.toString() ?: return null
              val lower = target.lowercase()
              if (lower.startsWith("data:") || lower.startsWith("blob:")) return null
              if (!isSafeBrowserUrl(target, false)) {
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
              }
              return null
            }
          }
        }
        val d = resources.displayMetrics.density
        val lp = FrameLayout.LayoutParams(
          (w * d).toInt().coerceAtLeast(1),
          (h * d).toInt().coerceAtLeast(1)
        ).apply {
          leftMargin = (x * d).toInt().coerceAtLeast(0)
          topMargin = (y * d).toInt().coerceAtLeast(0)
        }
        root.addView(child, lp)
        xappWeb = child
        child.loadUrl(url)
        onDone(Result.success(Unit))
      } catch (e: Exception) {
        onDone(Result.failure(e))
      }
    }
  }

  fun xappBounds(x: Double, y: Double, w: Double, h: Double) {
    runOnUiThread {
      val child = xappWeb ?: return@runOnUiThread
      val d = resources.displayMetrics.density
      val lp = (child.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
      lp.width = (w * d).toInt().coerceAtLeast(1)
      lp.height = (h * d).toInt().coerceAtLeast(1)
      lp.leftMargin = (x * d).toInt().coerceAtLeast(0)
      lp.topMargin = (y * d).toInt().coerceAtLeast(0)
      child.layoutParams = lp
    }
  }

  fun xappNavigate(url: String, onDone: (Result<Unit>) -> Unit) {
    if (!isHttpsXUrl(url)) {
      onDone(Result.failure(IllegalArgumentException("The X app only opens x.com.")))
      return
    }
    runOnUiThread {
      val child = xappWeb
      if (child == null) {
        onDone(Result.failure(IllegalStateException("X view not open")))
      } else {
        child.loadUrl(url)
        onDone(Result.success(Unit))
      }
    }
  }

  fun xappVisible(visible: Boolean) {
    runOnUiThread {
      xappWeb?.visibility = if (visible) View.VISIBLE else View.GONE
    }
  }

  fun xappZoom(zoom: Double) {
    runOnUiThread {
      xappWeb?.settings?.textZoom = (zoom * 100.0).toInt().coerceIn(50, 250)
    }
  }

  fun xappHistory(action: String) {
    runOnUiThread {
      val child = xappWeb ?: return@runOnUiThread
      when (action) {
        "reload" -> child.reload()
        "back" -> if (child.canGoBack()) child.goBack()
        "forward" -> if (child.canGoForward()) child.goForward()
      }
    }
  }

  fun xappEval(js: String) {
    runOnUiThread {
      val child = xappWeb ?: return@runOnUiThread
      if (isHttpsXUrl(child.url)) {
        child.evaluateJavascript(js, null)
      }
    }
  }

  fun xappClose() {
    runOnUiThread {
      xappWeb?.let { child ->
        (child.parent as? ViewGroup)?.removeView(child)
        child.destroy()
      }
      xappWeb = null
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    web = webView
    // Tauri's default Android WebView can keep a desktop-ish 800x600@1x layout viewport
    // (ignoring width=device-width) even on a 448dp phone. Make the real phone viewport win.
    webView.settings.apply {
      useWideViewPort = true
      loadWithOverviewMode = false
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
      textZoom = 100
      mediaPlaybackRequiresUserGesture = false
      setSupportMultipleWindows(true)
    }
    webView.setInitialScale(0)

    // Preserve Tauri's file-chooser WebChromeClient while adding camera QR permissions
    // (strictly gated to https://ros.localhost) and target="_blank" external handoff.
    val delegate = if (Build.VERSION.SDK_INT >= 26) webView.webChromeClient else null
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        w: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?
      ): Boolean {
        suppressNextAutoLock = true
        return delegate?.onShowFileChooser(w, filePathCallback, fileChooserParams) ?: false
      }

      override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        return delegate?.onJsAlert(view, url, message, result) ?: super.onJsAlert(view, url, message, result)
      }

      override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        return delegate?.onJsConfirm(view, url, message, result) ?: super.onJsConfirm(view, url, message, result)
      }

      override fun onJsPrompt(
        view: WebView?,
        url: String?,
        message: String?,
        defaultValue: String?,
        result: JsPromptResult?
      ): Boolean {
        return delegate?.onJsPrompt(view, url, message, defaultValue, result)
          ?: super.onJsPrompt(view, url, message, defaultValue, result)
      }

      override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
        return delegate?.onConsoleMessage(consoleMessage) ?: super.onConsoleMessage(consoleMessage)
      }

      override fun onReceivedTitle(view: WebView?, title: String?) {
        delegate?.onReceivedTitle(view, title)
      }

      override fun onProgressChanged(view: WebView?, newProgress: Int) {
        delegate?.onProgressChanged(view, newProgress)
      }

      override fun onPermissionRequest(request: PermissionRequest?) {
        if (request == null) return
        val origin = request.origin?.toString() ?: ""
        val wantsVideo = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        if (origin == "https://ros.localhost" && wantsVideo) {
          if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
          } else {
            pendingCameraRequest?.deny()
            pendingCameraRequest = request
            suppressNextAutoLock = true
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
          }
        } else {
          request.deny()
        }
      }

      override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
        if (!isUserGesture || view == null) return false
        val hit = view.hitTestResult
        val target = hit.extra
        if (!target.isNullOrBlank() && (target.startsWith("https://") || target.startsWith("http://"))) {
          try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
          } catch (_: Exception) { }
          return true
        }
        return false
      }
    }
    pushInsets()
  }

  private fun pushInsets() {
    val w = web ?: return
    val d = resources.displayMetrics.density
    val modeId = resources.getIdentifier("config_navBarInteractionMode", "integer", "android")
    val nav = if (modeId > 0 && resources.getInteger(modeId) == 2) "gestures" else "buttons"
    val js = "(function(){var r=document.documentElement;if(!r)return;" +
      "r.style.setProperty('--sa-t','${insetTop / d}px');" +
      "r.style.setProperty('--sa-b','${insetBottom / d}px');" +
      "r.style.setProperty('--sa-l','${insetLeft / d}px');" +
      "r.style.setProperty('--sa-r','${insetRight / d}px');" +
      "r.setAttribute('data-system-nav','$nav');})()"
    w.evaluateJavascript(js, null)
  }

  private fun handleLaunchIntent(intent: Intent?, coldStart: Boolean) {
    val uri = intent?.data?.toString()
    val soloExtra = intent?.getStringExtra("ripley_solo_app")
    if (coldStart) {
      if (!soloExtra.isNullOrBlank()) {
        nativeSetLaunchSoloApp(soloExtra)
        return
      }
      if (!uri.isNullOrBlank()) {
        val m = Regex("^ripley://solo/([a-zA-Z0-9_-]+(?:/[a-zA-Z0-9._~:/@-]*)?)(?:[?#].*)?$").matchEntire(uri.trim())
        if (m != null) {
          nativeSetLaunchSoloApp(m.groupValues[1])
          return
        }
        nativeDeepLink(uri)
      }
    } else {
      if (!soloExtra.isNullOrBlank()) {
        nativeDeepLink("ripley://solo/$soloExtra")
      } else if (!uri.isNullOrBlank()) {
        nativeDeepLink(uri)
      }
    }
  }

  private fun registerNetworkMonitor() {
    try {
      val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
      val req = NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          if (hasSeenNetwork) {
            nativeNetworkChanged()
          } else {
            hasSeenNetwork = true
          }
        }
      }
      networkCallback = cb
      cm.registerNetworkCallback(req, cb)
    } catch (_: Exception) { }
  }

  override fun onCreate(state: Bundle?) {
    // Capture cold-start SOLO shortcut / deep link BEFORE Tauri setup creates the WebView.
    handleLaunchIntent(intent, coldStart = true)
    super.onCreate(state)
    LauncherIcons.applyTaskDescription(this)
    // Edge-to-edge: the WebView reaches the screen edges; the insets go to the web app as
    // --sa-* (its topbar/nav/panes already reserve those), instead of padding the content.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= 29) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, i ->
      val b = i.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      insetTop = b.top; insetBottom = b.bottom; insetLeft = b.left; insetRight = b.right
      pushInsets()
      i
    }
    ViewCompat.requestApplyInsets(content)
    handler.post(pump)
    registerNetworkMonitor()

    // Android Back / gesture back: embedded browser history first, then ROS shell
    // (overlays, sheets, windows, SOLO sub-routes/tabs, pager). False at root
    // backgrounds cleanly to Android Home (keeping Tor/wallet process warm).
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val xw = xappWeb
        if (xw != null && xw.visibility == View.VISIBLE && xw.canGoBack()) {
          xw.goBack()
          return
        }
        val child = embedWeb
        if (child != null && child.visibility == View.VISIBLE && child.canGoBack()) {
          child.goBack()
          return
        }
        val w = web
        if (w == null) { moveTaskToBack(true); return }
        w.evaluateJavascript(
          "(function(){try{return !!(window.__rosSystemBack&&window.__rosSystemBack('native'));}catch(e){return false;}})()"
        ) { r -> if (r != "true") moveTaskToBack(true) }
      }
    })
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleLaunchIntent(intent, coldStart = false)
  }

  override fun onDestroy() {
    handler.removeCallbacks(pump)
    embedClose()
    xappClose()
    networkCallback?.let { cb ->
      try {
        (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(cb)
      } catch (_: Exception) { }
    }
    networkCallback = null
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    suppressNextAutoLock = false
    LauncherIcons.applyTaskDescription(this)
    nativeResume()
  }
  override fun onPause() {
    nativeLock()
    super.onPause()
  }
  override fun onStop() {
    if (!suppressNextAutoLock && !isChangingConfigurations) {
      nativeBackgroundLock()
    }
    super.onStop()
  }
}
