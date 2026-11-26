package run.ripley.terminal

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.widget.LinearLayout
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import java.lang.ref.WeakReference
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// Deliberately NOT TauriActivity: no invoke bridge, JS interfaces, custom protocols,
// file access, wallet commands, permission grants or inherited native capabilities.
class IsolatedBrowserActivity: Activity() {
  companion object {
    var current: WeakReference<IsolatedBrowserActivity>?=null
    fun allowed(url:String):Boolean {
      val u=Uri.parse(url);val h=u.host?.lowercase() ?: return false
      return u.scheme=="https" && u.userInfo==null && (u.port==-1 || u.port==443) && h!="localhost" && !h.endsWith(".localhost") && !h.endsWith(".onion") && !h.endsWith(".local") && !h.matches(Regex("[0-9.:]+"))
    }
  }
  private lateinit var web:WebView
  private var backInvokedCb: OnBackInvokedCallback? = null
  override fun onCreate(state:Bundle?) {
    super.onCreate(state);current=WeakReference(this)
    if (Build.VERSION.SDK_INT >= 33) {
      val cb = OnBackInvokedCallback { if (web.canGoBack()) web.goBack() else finish() }
      backInvokedCb = cb
      onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
    }
    val box=LinearLayout(this).apply {orientation=LinearLayout.VERTICAL}
    val label=TextView(this).apply {text="← Back to RipleyOS · CLEARNET browser · NO WALLET BRIDGE";setPadding(12,12,12,12);setOnClickListener {finish()}}
    web=WebView(this)
    web.settings.javaScriptEnabled=true
    web.settings.domStorageEnabled=true
    web.settings.allowFileAccess=false
    web.settings.allowContentAccess=false
    web.settings.mixedContentMode=android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
    web.webViewClient=object:WebViewClient() {
      override fun onPageFinished(v:WebView,url:String) {
        if(BuildConfig.DEBUG) v.evaluateJavascript("JSON.stringify({tauri:typeof window.__TAURI__,native:typeof window.__rosNative,ipc:typeof window.ipc,origin:location.origin})") {android.util.Log.i("AndroidBrowserIsolation",it)}
      }
      override fun shouldOverrideUrlLoading(v:WebView,r:WebResourceRequest):Boolean = !allowed(r.url.toString())
    }
    box.addView(label);box.addView(web,LinearLayout.LayoutParams(-1,0,1f));setContentView(box)
    ViewCompat.setOnApplyWindowInsetsListener(box){v,i->val b=i.getInsets(WindowInsetsCompat.Type.systemBars());v.setPadding(b.left,b.top,b.right,b.bottom);i}
    val url=intent.getStringExtra("url") ?: "https://example.com/"
    if(allowed(url))web.loadUrl(url) else label.text="Unsupported URL — Back to RipleyOS"
  }
  @Deprecated("Legacy back for minSdk24") override fun onBackPressed(){if(web.canGoBack())web.goBack()else finish()}
  override fun onDestroy(){
    if (Build.VERSION.SDK_INT >= 33) {
      backInvokedCb?.let { try { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) } catch (_: Exception) {} }
      backInvokedCb = null
    }
    web.stopLoading();web.destroy();current=null;super.onDestroy()
  }
}
