package run.ripley.terminal

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import android.os.Handler
import android.os.Looper
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg class ClipboardArgs { lateinit var text: String }
@InvokeArg class BrowserArgs { lateinit var url: String }
@InvokeArg class ExportArgs { lateinit var name: String; lateinit var base64: String; var mime: String = "application/octet-stream" }
@InvokeArg class SecureScreenArgs { var enabled: Boolean = false }
@InvokeArg class SystemBarsArgs { var light: Boolean = false }
@InvokeArg class AppIconArgs { lateinit var iconId: String }
@InvokeArg class ProxyArgs { var proxyUrl: String? = null }
@InvokeArg class PinShortcutArgs {
  lateinit var appId: String
  lateinit var label: String
  var iconBase64: String? = null
}
@InvokeArg class EmbedOpenArgs {
  lateinit var url: String
  var x: Double = 0.0
  var y: Double = 0.0
  var w: Double = 360.0
  var h: Double = 600.0
  var bg: String? = null
  var zoom: Double? = null
  var allowOnion: Boolean = false
}
@InvokeArg class EmbedBoundsArgs {
  var x: Double = 0.0
  var y: Double = 0.0
  var w: Double = 360.0
  var h: Double = 600.0
}
@InvokeArg class EmbedNavArgs {
  lateinit var url: String
  var allowOnion: Boolean = false
}
@InvokeArg class EmbedVisibleArgs { var visible: Boolean = true }
@InvokeArg class EmbedZoomArgs { var zoom: Double = 1.0 }
@InvokeArg class XappOpenArgs {
  lateinit var url: String
  var script: String? = null
  var x: Double = 0.0
  var y: Double = 0.0
  var w: Double = 360.0
  var h: Double = 600.0
  var bg: String? = null
  var zoom: Double? = null
}
@InvokeArg class XappNavArgs { lateinit var url: String }
@InvokeArg class XappHistoryArgs { lateinit var action: String }
@InvokeArg class XappEvalArgs { lateinit var js: String }
@InvokeArg class BioSealArgs {
  lateinit var secretBase64: String
  var title: String = "Biometric unlock"
  var subtitle: String? = null
}
@InvokeArg class BioUnsealArgs {
  lateinit var ivBase64: String
  lateinit var ctBase64: String
  var title: String = "Unlock"
  var subtitle: String? = null
}

@TauriPlugin
class NativeIoPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val KEYSTORE_ALIAS = "ripley_watch_key_v1"
    private const val BIO_KEYSTORE_ALIAS = "ripley_bio_unlock_v1"
    private const val PREFS_NAME = "ripley_keystore_watch_v1"
    private const val PREF_CT = "watch_root_ct"
    private const val PREF_IV = "watch_root_iv"
  }

  private val ioExecutor = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  private fun mainActivity(): MainActivity? = activity as? MainActivity

  @Command fun readClipboard(invoke: Invoke) {
    try {
      val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString() ?: ""
      require(text.length <= 65536) { "Clipboard exceeds 64 KiB text limit" }
      invoke.resolve(JSObject().put("text", text))
    } catch (e: Exception) { invoke.reject(e.message ?: "Clipboard read failed") }
  }

  @Command fun writeClipboard(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(ClipboardArgs::class.java)
      require(a.text.length <= 65536) { "Clipboard exceeds 64 KiB text limit" }
      val clip = ClipData.newPlainText("RipleyOS", a.text)
      if (Build.VERSION.SDK_INT >= 24) {
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
      }
      (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
      invoke.resolve(JSObject().put("written", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "Clipboard write failed") }
  }

  @Command fun setSecureScreen(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(SecureScreenArgs::class.java)
      mainActivity()?.setSecureScreen(a.enabled)
      invoke.resolve(JSObject().put("enabled", a.enabled))
    } catch (e: Exception) { invoke.reject(e.message ?: "Secure screen update failed") }
  }

  @Command fun setSystemBars(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(SystemBarsArgs::class.java)
      mainActivity()?.setSystemBars(a.light)
      invoke.resolve(JSObject().put("light", a.light))
    } catch (e: Exception) { invoke.reject(e.message ?: "System bars update failed") }
  }

  private fun currentActiveIconId(): String {
    val pm = activity.packageManager
    val pkg = activity.packageName
    for (entry in LauncherIcons.ALL) {
      val cn = ComponentName(pkg, entry.aliasClass)
      val state = pm.getComponentEnabledSetting(cn)
      if (state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
        return entry.id
      }
      if (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && entry.id == LauncherIcons.DEFAULT_ID) {
        return entry.id
      }
    }
    return LauncherIcons.DEFAULT_ID
  }

  @Command fun listAppIcons(invoke: Invoke) {
    try {
      val active = currentActiveIconId()
      val arr = org.json.JSONArray()
      for (entry in LauncherIcons.ALL) {
        arr.put(JSObject().put("id", entry.id).put("label", entry.label))
      }
      invoke.resolve(JSObject().put("activeIcon", active).put("icons", arr))
    } catch (e: Exception) { invoke.reject(e.message ?: "Failed to list launcher icons") }
  }

  /** Switch the Android launcher icon & label via <activity-alias>.
   *  Enables the target alias BEFORE disabling others so the app never has zero launcher entries,
   *  and passes DONT_KILL_APP so Tor/Wallet stays alive while the launcher refreshes. */
  @Command fun setAppIcon(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(AppIconArgs::class.java)
      val requested = a.iconId.trim().lowercase()
      val target = LauncherIcons.BY_ID[requested] ?: LauncherIcons.BY_ID.getValue(LauncherIcons.DEFAULT_ID)
      val pm = activity.packageManager
      val pkg = activity.packageName

      val targetCn = ComponentName(pkg, target.aliasClass)
      val targetState = pm.getComponentEnabledSetting(targetCn)
      val alreadySoleActive = (targetState == PackageManager.COMPONENT_ENABLED_STATE_ENABLED ||
        (targetState == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && target.id == LauncherIcons.DEFAULT_ID)) &&
        LauncherIcons.ALL.all { entry ->
          if (entry.id == target.id) true
          else {
            val st = pm.getComponentEnabledSetting(ComponentName(pkg, entry.aliasClass))
            st == PackageManager.COMPONENT_ENABLED_STATE_DISABLED ||
              (st == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && entry.id != LauncherIcons.DEFAULT_ID)
          }
        }

      if (alreadySoleActive) {
        LauncherIcons.applyTaskDescription(activity, target)
        invoke.resolve(JSObject().put("applied", true).put("changed", false).put("activeIcon", target.id))
        return
      }

      // 1. Enable target first so the package always has at least one LAUNCHER component.
      pm.setComponentEnabledSetting(
        targetCn,
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
        PackageManager.DONT_KILL_APP
      )
      // 2. Disable all other aliases.
      for (entry in LauncherIcons.ALL) {
        if (entry.id == target.id) continue
        val cn = ComponentName(pkg, entry.aliasClass)
        val st = pm.getComponentEnabledSetting(cn)
        val isImplicitlyDisabled = st == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && entry.id != LauncherIcons.DEFAULT_ID
        if (st != PackageManager.COMPONENT_ENABLED_STATE_DISABLED && !isImplicitlyDisabled) {
          pm.setComponentEnabledSetting(
            cn,
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP
          )
        }
      }
      LauncherIcons.applyTaskDescription(activity, target)
      invoke.resolve(JSObject().put("applied", true).put("changed", true).put("activeIcon", target.id))
    } catch (e: Exception) { invoke.reject(e.message ?: "App icon switch failed") }
  }

  @Command fun applyProxy(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(ProxyArgs::class.java)
      val host = mainActivity()
      if (host == null) {
        invoke.resolve(JSObject().put("applied", false))
        return
      }
      val done = AtomicBoolean(false)
      val timeout = Runnable {
        if (done.compareAndSet(false, true)) {
          invoke.resolve(JSObject().put("applied", false))
        }
      }
      mainHandler.postDelayed(timeout, 3000)
      host.applyWebViewProxy(a.proxyUrl) { ok ->
        mainHandler.removeCallbacks(timeout)
        if (done.compareAndSet(false, true)) {
          invoke.resolve(JSObject().put("applied", ok))
        }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "Proxy update failed") }
  }

  @Command fun pinShortcut(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(PinShortcutArgs::class.java)
      require(Regex("^[a-z0-9_-]{1,32}$").matches(a.appId)) { "Invalid appId" }
      require(a.label.isNotBlank() && a.label.length <= 64) { "Invalid label" }
      if (!ShortcutManagerCompat.isRequestPinShortcutSupported(activity)) {
        invoke.reject("Launcher does not support pinned shortcuts")
        return
      }
      val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse("ripley://solo/${a.appId}"), activity, MainActivity::class.java).apply {
        putExtra("ripley_solo_app", a.appId)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val icon = a.iconBase64?.takeIf { it.isNotBlank() }?.let { b64 ->
        try {
          val bytes = Base64.decode(b64, Base64.DEFAULT)
          BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { IconCompat.createWithAdaptiveBitmap(it) }
        } catch (_: Exception) { null }
      } ?: IconCompat.createWithResource(activity, R.mipmap.ic_launcher)

      val info = ShortcutInfoCompat.Builder(activity, "ros-solo-${a.appId}")
        .setShortLabel(a.label)
        .setLongLabel("${a.label} · RipleyOS")
        .setIcon(icon)
        .setIntent(launchIntent)
        .build()
      mainActivity()?.suppressNextAutoLock = true
      val requested = ShortcutManagerCompat.requestPinShortcut(activity, info, null)
      invoke.resolve(JSObject().put("pinned", requested))
    } catch (e: Exception) { invoke.reject(e.message ?: "Pin shortcut failed") }
  }

  /** Hardware-backed Android Keystore wrapper for the regenerable watch-only sync root.
   *  NEVER used for spend vaults (those remain password-portable Argon2id + ChaCha20-Poly1305). */
  @Command fun ensureWatchKey(invoke: Invoke) {
    try {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val secretKey = (ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey) ?: run {
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
          KEYSTORE_ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .apply { if (Build.VERSION.SDK_INT >= 28) setUnlockedDeviceRequired(true) }
          .build()
        kg.init(spec)
        kg.generateKey()
      }
      val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val existingCt = prefs.getString(PREF_CT, null)
      val existingIv = prefs.getString(PREF_IV, null)
      var rawKey: ByteArray? = null
      if (existingCt != null && existingIv != null) {
        try {
          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, Base64.decode(existingIv, Base64.NO_WRAP)))
          val decrypted = cipher.doFinal(Base64.decode(existingCt, Base64.NO_WRAP))
          if (decrypted.size == 32) {
            rawKey = decrypted
          }
        } catch (_: GeneralSecurityException) {
          // Keystore key was invalidated or reset; clear stale ciphertext and regenerate the
          // watch root below (watch files are regenerable from the wallet on next unlock).
          prefs.edit().remove(PREF_CT).remove(PREF_IV).apply()
        } catch (_: IllegalArgumentException) {
          prefs.edit().remove(PREF_CT).remove(PREF_IV).apply()
        }
      }
      if (rawKey == null) {
        val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        val ct = cipher.doFinal(fresh)
        prefs.edit()
          .putString(PREF_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
          .putString(PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
          .apply()
        rawKey = fresh
      }
      invoke.resolve(JSObject().put("keyBase64", Base64.encodeToString(rawKey, Base64.NO_WRAP)))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Android Keystore unavailable")
    }
  }

  @Command fun openExternalUrl(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BrowserArgs::class.java)
      val u = Uri.parse(args.url)
      val s = u.scheme?.lowercase()
      require((s == "https" || s == "http") && u.userInfo == null && args.url.length <= 2048) {
        "Only valid http(s) URLs without credentials are allowed"
      }
      activity.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      invoke.resolve(JSObject().put("opened", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "Could not open external URL") }
  }

  @Command fun openBrowser(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(BrowserArgs::class.java)
      require(IsolatedBrowserActivity.allowed(args.url)) { "Public HTTPS only; Tor/local/private URLs are not supported" }
      activity.startActivity(Intent(activity, IsolatedBrowserActivity::class.java).putExtra("url", args.url))
      invoke.resolve(JSObject().put("mode", "isolated-activity").put("walletBridge", false))
    } catch (e: Exception) { invoke.reject(e.message ?: "Browser could not open") }
  }

  @Command fun closeBrowser(invoke: Invoke) {
    activity.runOnUiThread {
      IsolatedBrowserActivity.current?.get()?.finish()
      mainActivity()?.embedClose()
      invoke.resolve(JSObject().put("closed", true))
    }
  }

  @Command fun embedOpen(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedOpenArgs::class.java)
      val host = mainActivity() ?: return invoke.reject("MainActivity unavailable")
      host.embedOpen(a.url, a.x, a.y, a.w, a.h, a.bg, a.zoom, a.allowOnion) { res ->
        res.onSuccess { invoke.resolve(JSObject().put("opened", true)) }
          .onFailure { invoke.reject(it.message ?: "Embedded browser open failed") }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "Embedded browser open failed") }
  }

  @Command fun embedBounds(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedBoundsArgs::class.java)
      mainActivity()?.embedBounds(a.x, a.y, a.w, a.h)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "Bounds update failed") }
  }

  @Command fun embedNavigate(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedNavArgs::class.java)
      val host = mainActivity() ?: return invoke.reject("MainActivity unavailable")
      host.embedNavigate(a.url, a.allowOnion) { res ->
        res.onSuccess { invoke.resolve(JSObject().put("ok", true)) }
          .onFailure { invoke.reject(it.message ?: "Navigate failed") }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "Navigate failed") }
  }

  @Command fun embedVisible(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedVisibleArgs::class.java)
      mainActivity()?.embedVisible(a.visible)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "Visible update failed") }
  }

  @Command fun embedZoom(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedZoomArgs::class.java)
      mainActivity()?.embedZoom(a.zoom)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "Zoom update failed") }
  }

  @Command fun embedClose(invoke: Invoke) {
    mainActivity()?.embedClose()
    invoke.resolve(JSObject().put("closed", true))
  }

  @Command fun xappOpen(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(XappOpenArgs::class.java)
      val host = mainActivity() ?: return invoke.reject("MainActivity unavailable")
      host.xappOpen(a.url, a.script, a.x, a.y, a.w, a.h, a.bg, a.zoom) { res ->
        res.onSuccess { invoke.resolve(JSObject().put("opened", true)) }
          .onFailure { invoke.reject(it.message ?: "X view open failed") }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "X view open failed") }
  }

  @Command fun xappBounds(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedBoundsArgs::class.java)
      mainActivity()?.xappBounds(a.x, a.y, a.w, a.h)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "X bounds update failed") }
  }

  @Command fun xappNavigate(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(XappNavArgs::class.java)
      val host = mainActivity() ?: return invoke.reject("MainActivity unavailable")
      host.xappNavigate(a.url) { res ->
        res.onSuccess { invoke.resolve(JSObject().put("ok", true)) }
          .onFailure { invoke.reject(it.message ?: "X navigate failed") }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "X navigate failed") }
  }

  @Command fun xappVisible(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedVisibleArgs::class.java)
      mainActivity()?.xappVisible(a.visible)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "X visibility update failed") }
  }

  @Command fun xappZoom(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(EmbedZoomArgs::class.java)
      mainActivity()?.xappZoom(a.zoom)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "X zoom update failed") }
  }

  @Command fun xappHistory(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(XappHistoryArgs::class.java)
      mainActivity()?.xappHistory(a.action)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "X history failed") }
  }

  @Command fun xappEval(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(XappEvalArgs::class.java)
      mainActivity()?.xappEval(a.js)
      invoke.resolve(JSObject().put("ok", true))
    } catch (e: Exception) { invoke.reject(e.message ?: "X eval failed") }
  }

  @Command fun xappClose(invoke: Invoke) {
    mainActivity()?.xappClose()
    invoke.resolve(JSObject().put("closed", true))
  }

  // ── Pure AOSP Hardware Biometric Unlock (Zero Google / GMS — GrapheneOS & Pixel Titan M2) ──

  private fun deleteBioKey() {
    try {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (ks.containsAlias(BIO_KEYSTORE_ALIAS)) {
        ks.deleteEntry(BIO_KEYSTORE_ALIAS)
      }
    } catch (_: Exception) { }
  }

  private fun generateBioKey(strongBox: Boolean): SecretKey {
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val builder = KeyGenParameterSpec.Builder(
      BIO_KEYSTORE_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= 30) {
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    if (strongBox && Build.VERSION.SDK_INT >= 28) {
      builder.setIsStrongBoxBacked(true)
    }
    gen.init(builder.build())
    return gen.generateKey()
  }

  private fun createHardwareBioKey(): SecretKey {
    deleteBioKey()
    if (Build.VERSION.SDK_INT >= 28) {
      try {
        return generateBioKey(strongBox = true)
      } catch (_: StrongBoxUnavailableException) {
        deleteBioKey()
      } catch (_: ProviderException) {
        deleteBioKey()
      }
    }
    return generateBioKey(strongBox = false)
  }

  @Command fun bioStatus(invoke: Invoke) {
    try {
      val res = BiometricManager.from(activity)
        .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      invoke.resolve(
        JSObject()
          .put("supported", res == BiometricManager.BIOMETRIC_SUCCESS)
          .put("status", res)
      )
    } catch (e: Exception) {
      invoke.resolve(JSObject().put("supported", false).put("status", -1))
    }
  }

  @Command fun bioSeal(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(BioSealArgs::class.java)
      val plain = Base64.decode(a.secretBase64, Base64.DEFAULT)
      require(plain.isNotEmpty() && plain.size <= 4096) { "Invalid secret size" }
      val fa = activity as? FragmentActivity
      if (fa == null) {
        invoke.resolve(JSObject().put("status", "unsupported"))
        return
      }
      val can = BiometricManager.from(fa)
        .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      if (can != BiometricManager.BIOMETRIC_SUCCESS) {
        invoke.resolve(JSObject().put("status", "unsupported"))
        return
      }
      val key = createHardwareBioKey()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.ENCRYPT_MODE, key)
      }
      val settled = AtomicBoolean(false)
      val finish = { obj: JSObject ->
        if (settled.compareAndSet(false, true)) invoke.resolve(obj)
      }
      fa.runOnUiThread {
        try {
          val prompt = BiometricPrompt(
            fa,
            ContextCompat.getMainExecutor(fa),
            object : BiometricPrompt.AuthenticationCallback() {
              override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try {
                  val c = result.cryptoObject?.cipher ?: error("No crypto object")
                  val ct = c.doFinal(plain)
                  val iv = c.iv
                  plain.fill(0)
                  finish(
                    JSObject()
                      .put("status", "ok")
                      .put("ivBase64", Base64.encodeToString(iv, Base64.NO_WRAP))
                      .put("ctBase64", Base64.encodeToString(ct, Base64.NO_WRAP))
                  )
                } catch (_: Exception) {
                  plain.fill(0)
                  deleteBioKey()
                  finish(JSObject().put("status", "unsupported"))
                }
              }
              override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                plain.fill(0)
                val cancelled = errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                  errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                  errorCode == BiometricPrompt.ERROR_CANCELED ||
                  errorCode == BiometricPrompt.ERROR_LOCKOUT ||
                  errorCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT
                if (!cancelled) deleteBioKey()
                finish(JSObject().put("status", if (cancelled) "cancelled" else "unsupported"))
              }
            }
          )
          val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(a.title.ifBlank { "Biometric unlock" })
            .apply { if (!a.subtitle.isNullOrBlank()) setSubtitle(a.subtitle) }
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()
          prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        } catch (_: Exception) {
          plain.fill(0)
          deleteBioKey()
          finish(JSObject().put("status", "unsupported"))
        }
      }
    } catch (_: Exception) {
      deleteBioKey()
      invoke.resolve(JSObject().put("status", "unsupported"))
    }
  }

  @Command fun bioUnseal(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(BioUnsealArgs::class.java)
      val iv = Base64.decode(a.ivBase64, Base64.DEFAULT)
      val ct = Base64.decode(a.ctBase64, Base64.DEFAULT)
      if (iv.size != 12 || ct.size < 17 || ct.size > 4200) {
        invoke.resolve(JSObject().put("status", "gone"))
        return
      }
      val fa = activity as? FragmentActivity
      if (fa == null) {
        invoke.resolve(JSObject().put("status", "gone"))
        return
      }
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = ks.getKey(BIO_KEYSTORE_ALIAS, null) as? SecretKey
      if (key == null) {
        invoke.resolve(JSObject().put("status", "gone"))
        return
      }
      val cipher = try {
        Cipher.getInstance("AES/GCM/NoPadding").apply {
          init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        }
      } catch (_: KeyPermanentlyInvalidatedException) {
        deleteBioKey()
        invoke.resolve(JSObject().put("status", "gone"))
        return
      }
      val settled = AtomicBoolean(false)
      val finish = { obj: JSObject ->
        if (settled.compareAndSet(false, true)) invoke.resolve(obj)
      }
      fa.runOnUiThread {
        try {
          val prompt = BiometricPrompt(
            fa,
            ContextCompat.getMainExecutor(fa),
            object : BiometricPrompt.AuthenticationCallback() {
              override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                try {
                  val c = result.cryptoObject?.cipher ?: error("No crypto object")
                  val plain = c.doFinal(ct)
                  val b64 = Base64.encodeToString(plain, Base64.NO_WRAP)
                  plain.fill(0)
                  finish(JSObject().put("status", "ok").put("secretBase64", b64))
                } catch (_: Exception) {
                  deleteBioKey()
                  finish(JSObject().put("status", "gone"))
                }
              }
              override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                finish(JSObject().put("status", "cancelled"))
              }
            }
          )
          val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(a.title.ifBlank { "Unlock" })
            .apply { if (!a.subtitle.isNullOrBlank()) setSubtitle(a.subtitle) }
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Use passcode")
            .build()
          prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        } catch (_: Exception) {
          finish(JSObject().put("status", "cancelled"))
        }
      }
    } catch (_: Exception) {
      invoke.resolve(JSObject().put("status", "gone"))
    }
  }

  @Command fun bioClear(invoke: Invoke) {
    deleteBioKey()
    invoke.resolve(JSObject().put("cleared", true))
  }

  @Command fun saveExport(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(ExportArgs::class.java)
      require(a.name.length in 1..120 && !a.name.contains('/') && !a.name.contains('\\')) { "Invalid export name" }
      require(a.base64.length <= 24 * 1024 * 1024) { "Export exceeds size limit" }
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = a.mime
        putExtra(Intent.EXTRA_TITLE, a.name)
      }
      mainActivity()?.suppressNextAutoLock = true
      startActivityForResult(invoke, intent, "exportResult")
    } catch (e: Exception) { invoke.reject(e.message ?: "Save picker failed") }
  }

  @ActivityCallback fun exportResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.resolve(JSObject().put("saved", false).put("cancelled", true))
      return
    }
    try {
      val a = invoke.parseArgs(ExportArgs::class.java)
      val uri = result.data?.data ?: error("No destination")
      ioExecutor.execute {
        try {
          val bytes = Base64.decode(a.base64, Base64.DEFAULT)
          require(bytes.size <= 16 * 1024 * 1024) { "Export exceeds size limit" }
          activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
            ?: error("Destination cannot be written")
          invoke.resolve(JSObject().put("saved", true).put("bytes", bytes.size).put("uri", uri.toString()))
        } catch (e: Exception) {
          invoke.reject(e.message ?: "Export write failed")
        }
      }
    } catch (e: Exception) { invoke.reject(e.message ?: "Export write failed") }
  }
}
