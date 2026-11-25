package run.ripley.terminal

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

data class VaultAccount(
  val id: String,
  val label: String,
  val pubkey: String,
  val npub: String
)

data class VaultInspection(
  val status: String, // "ready" | "locked" | "bad_passcode" | "no_identity" | "error"
  val hasPasscode: Boolean,
  val activePubkey: String?,
  val activeNpub: String?,
  val accounts: List<VaultAccount>,
  val error: String?
)

data class SignedEventOutcome(
  val ok: Boolean,
  val id: String = "",
  val pubkey: String = "",
  val sig: String = "",
  val event: String = "",
  val kind: Int = -1,
  val error: String? = null
)

data class KeystoreSealMaterial(
  val ok: Boolean,
  val pubkey: String = "",
  val skHex: String = "",
  val error: String? = null
)

object Nip55Bridge {
  init {
    System.loadLibrary("ripley_terminal_lib")
  }

  @JvmStatic private external fun nativeInspectVault(appDataDir: String, passcode: String?): String
  @JvmStatic private external fun nativeCreateIdentity(appDataDir: String): String
  @JvmStatic private external fun nativeSignWithVault(
    appDataDir: String,
    passcode: String?,
    targetPubkey: String?,
    eventJson: String
  ): String
  @JvmStatic private external fun nativeSignWithRawSk(
    skHex: String,
    expectedPubkey: String?,
    eventJson: String
  ): String
  @JvmStatic private external fun nativeExportForKeystoreSeal(
    appDataDir: String,
    passcode: String?,
    targetPubkey: String?
  ): String
  @JvmStatic private external fun nativeNormalizePubkey(input: String): String
  @JvmStatic private external fun nativeHexToNpub(input: String): String

  /** Matches Tauri PathPlugin.kt `getDataDir` so Rust `ros_kv` resolves the exact same `ros-kv/` dir. */
  fun appDataDir(context: Context): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      context.dataDir.absolutePath
    } else {
      context.applicationInfo.dataDir
    }

  fun normalizePubkey(input: String?): String? {
    if (input.isNullOrBlank()) return null
    val norm = nativeNormalizePubkey(input.trim())
    return norm.takeIf { it.length == 64 }
  }

  fun hexToNpub(pubkeyHex: String): String =
    nativeHexToNpub(pubkeyHex).ifBlank { pubkeyHex }

  fun inspectVault(context: Context, passcode: String? = null): VaultInspection {
    return try {
      val raw = nativeInspectVault(appDataDir(context), passcode)
      val o = JSONObject(raw)
      val accs = mutableListOf<VaultAccount>()
      val arr = o.optJSONArray("accounts") ?: JSONArray()
      for (i in 0 until arr.length()) {
        val item = arr.optJSONObject(i) ?: continue
        val pk = item.optString("pubkey", "")
        if (pk.length == 64) {
          accs.add(
            VaultAccount(
              id = item.optString("id", ""),
              label = item.optString("label", "Account"),
              pubkey = pk,
              npub = item.optString("npub", pk)
            )
          )
        }
      }
      VaultInspection(
        status = o.optString("status", "error"),
        hasPasscode = o.optBoolean("hasPasscode", false),
        activePubkey = o.optString("activePubkey", "").takeIf { it.length == 64 },
        activeNpub = o.optString("activeNpub", "").takeIf { it.isNotBlank() },
        accounts = accs,
        error = o.optString("error", "").takeIf { it.isNotBlank() }
      )
    } catch (e: Exception) {
      VaultInspection("error", false, null, null, emptyList(), e.message ?: "Vault inspection failed")
    }
  }

  fun createIdentity(context: Context): Result<VaultAccount> {
    return try {
      val o = JSONObject(nativeCreateIdentity(appDataDir(context)))
      if (!o.optBoolean("ok", false)) {
        return Result.failure(IllegalStateException(o.optString("error", "Create identity failed")))
      }
      val acc = o.getJSONObject("account")
      Result.success(
        VaultAccount(
          id = acc.optString("id", ""),
          label = acc.optString("label", "Account 1"),
          pubkey = acc.getString("pubkey"),
          npub = acc.getString("npub")
        )
      )
    } catch (e: Exception) {
      Result.failure(e)
    }
  }

  fun signWithVault(
    context: Context,
    passcode: String?,
    targetPubkey: String?,
    eventJson: String
  ): SignedEventOutcome {
    return parseSignOutcome(
      try {
        nativeSignWithVault(appDataDir(context), passcode, targetPubkey, eventJson)
      } catch (e: Exception) {
        return SignedEventOutcome(ok = false, error = e.message ?: "Native signing failed")
      }
    )
  }

  fun signWithRawSk(
    skHex: String,
    expectedPubkey: String?,
    eventJson: String
  ): SignedEventOutcome {
    return parseSignOutcome(
      try {
        nativeSignWithRawSk(skHex, expectedPubkey, eventJson)
      } catch (e: Exception) {
        return SignedEventOutcome(ok = false, error = e.message ?: "Native signing failed")
      }
    )
  }

  fun exportForKeystoreSeal(
    context: Context,
    passcode: String?,
    targetPubkey: String?
  ): KeystoreSealMaterial {
    return try {
      val o = JSONObject(nativeExportForKeystoreSeal(appDataDir(context), passcode, targetPubkey))
      if (!o.optBoolean("ok", false)) {
        KeystoreSealMaterial(ok = false, error = o.optString("error", "Key export failed"))
      } else {
        KeystoreSealMaterial(
          ok = true,
          pubkey = o.getString("pubkey"),
          skHex = o.getString("sk")
        )
      }
    } catch (e: Exception) {
      KeystoreSealMaterial(ok = false, error = e.message ?: "Key export failed")
    }
  }

  private fun parseSignOutcome(raw: String): SignedEventOutcome {
    return try {
      val o = JSONObject(raw)
      if (!o.optBoolean("ok", false)) {
        SignedEventOutcome(ok = false, error = o.optString("error", "Signing failed"))
      } else {
        SignedEventOutcome(
          ok = true,
          id = o.getString("id"),
          pubkey = o.getString("pubkey"),
          sig = o.getString("sig"),
          event = o.getString("event"),
          kind = o.optInt("kind", -1)
        )
      }
    } catch (e: Exception) {
      SignedEventOutcome(ok = false, error = e.message ?: "Malformed signing response")
    }
  }
}
