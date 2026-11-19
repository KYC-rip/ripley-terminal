package run.ripley.androidpoc

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg class BrowserArgs { lateinit var url: String }
@InvokeArg class ExportArgs { lateinit var name: String; lateinit var base64: String; var mime: String = "application/octet-stream" }

@TauriPlugin
class NativeIoPlugin(private val activity: Activity): Plugin(activity) {
  @Command fun openBrowser(invoke: Invoke) {
    try {
      val args=invoke.parseArgs(BrowserArgs::class.java)
      require(IsolatedBrowserActivity.allowed(args.url)) { "Public HTTPS only; Tor/local/private URLs are not supported" }
      activity.startActivity(Intent(activity,IsolatedBrowserActivity::class.java).putExtra("url",args.url))
      invoke.resolve(JSObject().put("mode","isolated-activity").put("walletBridge",false).put("transport","clearnet"))
    } catch(e: Exception) { invoke.reject(e.message ?: "Browser could not open") }
  }
  @Command fun closeBrowser(invoke: Invoke) {
    activity.runOnUiThread { IsolatedBrowserActivity.current?.get()?.finish();invoke.resolve(JSObject().put("closed",true)) }
  }
  @Command fun saveExport(invoke: Invoke) {
    try {
      val a=invoke.parseArgs(ExportArgs::class.java)
      require(a.name.length in 1..120 && !a.name.contains('/') && !a.name.contains('\\')) { "Invalid export name" }
      require(a.base64.length<=24*1024*1024) { "Export exceeds size limit" }
      val intent=Intent(Intent.ACTION_CREATE_DOCUMENT).apply {addCategory(Intent.CATEGORY_OPENABLE);type=a.mime;putExtra(Intent.EXTRA_TITLE,a.name)}
      startActivityForResult(invoke,intent,"exportResult")
    } catch(e: Exception) {invoke.reject(e.message ?: "Save picker failed")}
  }
  @ActivityCallback fun exportResult(invoke: Invoke,result: ActivityResult) {
    if(result.resultCode!=Activity.RESULT_OK) {invoke.resolve(JSObject().put("saved",false).put("cancelled",true));return}
    try {
      val a=invoke.parseArgs(ExportArgs::class.java)
      val bytes=Base64.decode(a.base64,Base64.DEFAULT)
      require(bytes.size<=16*1024*1024) { "Export exceeds size limit" }
      val uri=result.data?.data ?: error("No destination")
      activity.contentResolver.openOutputStream(uri,"wt")?.use {it.write(bytes)} ?: error("Destination cannot be written")
      invoke.resolve(JSObject().put("saved",true).put("bytes",bytes.size).put("uri",uri.toString()))
    } catch(e: Exception) {invoke.reject(e.message ?: "Export write failed")}
  }
}
