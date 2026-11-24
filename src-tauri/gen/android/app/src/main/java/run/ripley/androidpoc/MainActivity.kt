package run.ripley.androidpoc

import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private external fun nativeLock()
  private external fun nativeResume()

  private var web: android.webkit.WebView? = null
  private var insetTop = 0
  private var insetBottom = 0
  private var insetLeft = 0
  private var insetRight = 0
  private val handler = Handler(Looper.getMainLooper())
  /** The page is replaced by the archive load, so safe-area vars are (re)pushed for a few seconds
   *  after boot and on every insets change. */
  private val pump = object : Runnable {
    override fun run() { pushInsets(); handler.postDelayed(this, 700) }
  }

  override fun onWebViewCreate(webView: android.webkit.WebView) {
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
    }
    webView.setInitialScale(0)
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

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    // Edge-to-edge: the WebView reaches the screen edges; the insets go to the web app as
    // --sa-* (its topbar/nav/panes already reserve those), instead of padding the content.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = true
      isAppearanceLightNavigationBars = true
    }
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, i ->
      val b = i.getInsets(WindowInsetsCompat.Type.systemBars())
      insetTop = b.top; insetBottom = b.bottom; insetLeft = b.left; insetRight = b.right
      pushInsets()
      i
    }
    ViewCompat.requestApplyInsets(content)
    handler.post(pump)
    // Android Back / gesture back belongs to the ROS shell first: it arms history sentinels and
    // pops overlays, sheets, then the top window back to the desktop. Only when the WebView has no
    // history entry left does Back leave the app (the Android home gesture always can).
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val w = web
        if (w == null) { finish(); return }
        // The ROS shell decides: overlays/sheets/windows/pager first; false = plain desktop.
        w.evaluateJavascript(
          "(function(){try{return !!(window.__rosSystemBack&&window.__rosSystemBack());}catch(e){return false;}})()"
        ) { r -> if (r != "true") finish() }
      }
    })
  }

  override fun onDestroy() {
    handler.removeCallbacks(pump)
    super.onDestroy()
  }

  override fun onResume() { super.onResume(); nativeResume() }
  override fun onPause() { nativeLock(); super.onPause() }
}
