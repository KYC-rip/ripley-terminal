package run.ripley.terminal

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

sealed class NativeBioState {
  data class Ready(val iv: ByteArray, val ct: ByteArray) : NativeBioState()
  object Expired : NativeBioState()
  object Unavailable : NativeBioState()
}

data class CallerIdentity(
  val packageName: String,
  val certSha256: String,
  val appLabel: String
) {
  val grantKey: String get() = "$packageName|$certSha256"
}

data class CallerGrantRecord(
  val packageName: String,
  val certSha256: String,
  val appLabel: String,
  val pubkeyHex: String,
  val approved: Boolean,
  val rejected: Boolean,
  val approvedKinds: Set<Int>,
  val rejectedKinds: Set<Int>,
  val updatedAt: Long
)

sealed class SignPreAuthDecision {
  data class Authorized(val pubkeyHex: String) : SignPreAuthDecision()
  object ExplicitlyRejected : SignPreAuthDecision()
  object NotAuthorized : SignPreAuthDecision()
}

sealed class PubkeyPreAuthDecision {
  data class Authorized(val pubkeyHex: String) : PubkeyPreAuthDecision()
  object ExplicitlyRejected : PubkeyPreAuthDecision()
  object NotAuthorized : PubkeyPreAuthDecision()
}

object Nip55Store {
  private const val GRANTS_PREFS = "ripley_nip55_grants_v1"
  private const val SEALED_PREFS = "ripley_nip55_sealed_v1"
  private const val KEYSTORE_ALIAS = "ripley_nip55_vault_v1"
  private const val BIO_KEYSTORE_ALIAS = "ripley_bio_unlock_v1"
  private const val BIO_KV_FILE = "ripleyos%3Alock%3Abio"

  /** Public text notes (1) and long-form articles (30023) are NEVER pre-authorized during
   *  initial `get_public_key` connect, and can only be remembered when the user explicitly
   *  opts in on an interactive `sign_event` prompt. */
  val NEVER_AUTO_SIGN_KINDS: Set<Int> = setOf(1, 30023)

  fun isRestrictedKind(kind: Int): Boolean = kind in NEVER_AUTO_SIGN_KINDS

  /** Verify caller identity for an Activity started via startActivityForResult / ActivityResultLauncher. */
  fun resolveCallerForActivity(activity: Activity): CallerIdentity? {
    val pkg = activity.callingActivity?.packageName?.takeIf { it.isNotBlank() }
      ?: activity.callingPackage?.takeIf { it.isNotBlank() }
      ?: return null
    val cert = computeSigningCertSha256(activity, pkg) ?: return null
    val label = resolveAppLabel(activity, pkg)
    return CallerIdentity(packageName = pkg, certSha256 = cert, appLabel = label)
  }

  /** Verify caller identity for a ContentProvider Binder call using Binder.getCallingUid(). */
  fun resolveCallerForProvider(context: Context, callingPackage: String?): CallerIdentity? {
    val uid = Binder.getCallingUid()
    val uidPackages = context.packageManager.getPackagesForUid(uid)?.toSet() ?: return null
    if (uidPackages.isEmpty()) return null
    val pkg = when {
      !callingPackage.isNullOrBlank() && callingPackage in uidPackages -> callingPackage
      uidPackages.size == 1 -> uidPackages.first()
      else -> return null
    }
    val cert = computeSigningCertSha256(context, pkg) ?: return null
    val label = resolveAppLabel(context, pkg)
    return CallerIdentity(packageName = pkg, certSha256 = cert, appLabel = label)
  }

  fun computeSigningCertSha256(context: Context, packageName: String): String? {
    return try {
      val pm = context.packageManager
      val certs: List<ByteArray> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val pi = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val si = pi.signingInfo ?: return null
        val signers = if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
        signers?.map { it.toByteArray() } ?: emptyList()
      } else {
        @Suppress("DEPRECATION")
        val pi = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
        @Suppress("DEPRECATION")
        pi.signatures?.map { it.toByteArray() } ?: emptyList()
      }
      if (certs.isEmpty()) return null
      val md = MessageDigest.getInstance("SHA-256")
      certs.map { raw ->
        md.digest(raw).joinToString("") { "%02x".format(it) }
      }.sorted().joinToString(",")
    } catch (_: Exception) {
      null
    }
  }

  private fun resolveAppLabel(context: Context, packageName: String): String {
    return try {
      val pm = context.packageManager
      val ai = pm.getApplicationInfo(packageName, 0)
      pm.getApplicationLabel(ai).toString().takeIf { it.isNotBlank() } ?: packageName
    } catch (_: Exception) {
      packageName
    }
  }

  fun shortFingerprint(certSha256: String): String {
    val primary = certSha256.substringBefore(',').uppercase()
    if (primary.length < 16) return primary
    val head = primary.substring(0, 8).chunked(2).joinToString(":")
    val tail = primary.substring(primary.length - 8).chunked(2).joinToString(":")
    return "$head ··· $tail"
  }

  /** Parse NIP-55 `permissions` JSON array of `{ "type": "sign_event", "kind": <int> }`.
   *  Returns Pair(preAuthorizableKinds, blockedRestrictedKinds). */
  fun parseRequestedSignKinds(permissionsJson: String?): Pair<List<Int>, List<Int>> {
    if (permissionsJson.isNullOrBlank()) return emptyList<Int>() to emptyList()
    return try {
      val arr = JSONArray(permissionsJson)
      val allowed = linkedSetOf<Int>()
      val blocked = linkedSetOf<Int>()
      for (i in 0 until arr.length()) {
        val obj = arr.optJSONObject(i) ?: continue
        val type = obj.optString("type", "").trim()
        if (type != "sign_event") continue
        if (!obj.has("kind") || obj.isNull("kind")) continue
        val kind = obj.optInt("kind", -1)
        if (kind !in 0..65535) continue
        if (isRestrictedKind(kind)) blocked.add(kind) else allowed.add(kind)
      }
      allowed.sorted() to blocked.sorted()
    } catch (_: Exception) {
      emptyList<Int>() to emptyList()
    }
  }

  fun describeKind(kind: Int): String = when (kind) {
    0 -> "Profile Metadata"
    1 -> "Public Note"
    5 -> "Event Deletion"
    17 -> "External / Website Reaction"
    9042 -> "XMRadar / Zap Event"
    9044 -> "XMRadar / Receipt Event"
    10002 -> "Relay List Metadata"
    10011 -> "Service Configuration"
    10133 -> "App Preferences"
    24242 -> "Blossom Media Auth"
    27235 -> "NIP-98 HTTP Auth"
    30023 -> "Long-Form Article"
    else -> "Event Kind $kind"
  }

  // ── Per-Caller Per-Kind Grant Persistence ──

  fun loadGrant(context: Context, caller: CallerIdentity): CallerGrantRecord? {
    val prefs = context.getSharedPreferences(GRANTS_PREFS, Context.MODE_PRIVATE)
    val raw = prefs.getString(caller.grantKey, null) ?: return null
    return try {
      val o = JSONObject(raw)
      if (o.optString("packageName") != caller.packageName || o.optString("certSha256") != caller.certSha256) {
        return null
      }
      val approvedKinds = mutableSetOf<Int>()
      val aArr = o.optJSONArray("approvedKinds") ?: JSONArray()
      for (i in 0 until aArr.length()) {
        val k = aArr.optInt(i, -1)
        if (k in 0..65535) approvedKinds.add(k)
      }
      val rejectedKinds = mutableSetOf<Int>()
      val rArr = o.optJSONArray("rejectedKinds") ?: JSONArray()
      for (i in 0 until rArr.length()) {
        val k = rArr.optInt(i, -1)
        if (k in 0..65535) rejectedKinds.add(k)
      }
      CallerGrantRecord(
        packageName = caller.packageName,
        certSha256 = caller.certSha256,
        appLabel = o.optString("appLabel", caller.appLabel),
        pubkeyHex = o.optString("pubkeyHex", ""),
        approved = o.optBoolean("approved", false),
        rejected = o.optBoolean("rejected", false),
        approvedKinds = approvedKinds,
        rejectedKinds = rejectedKinds,
        updatedAt = o.optLong("updatedAt", 0L)
      )
    } catch (_: Exception) {
      null
    }
  }

  fun saveApproval(
    context: Context,
    caller: CallerIdentity,
    pubkeyHex: String,
    kindsToApprove: Collection<Int>,
    replaceKinds: Boolean = false,
    allowExplicitRestricted: Boolean = false
  ) {
    val existing = loadGrant(context, caller)
    val safeIncoming = kindsToApprove
      .filter { it in 0..65535 && (allowExplicitRestricted || !isRestrictedKind(it)) }
      .toSet()
    val mergedApproved = if (replaceKinds || existing == null || existing.pubkeyHex != pubkeyHex) {
      safeIncoming
    } else {
      existing.approvedKinds + safeIncoming
    }
    val mergedRejected = if (existing == null || existing.pubkeyHex != pubkeyHex) {
      emptySet()
    } else {
      existing.rejectedKinds - mergedApproved
    }
    writeGrant(
      context,
      CallerGrantRecord(
        packageName = caller.packageName,
        certSha256 = caller.certSha256,
        appLabel = caller.appLabel,
        pubkeyHex = pubkeyHex.lowercase(),
        approved = true,
        rejected = false,
        approvedKinds = mergedApproved,
        rejectedKinds = mergedRejected,
        updatedAt = System.currentTimeMillis() / 1000L
      )
    )
  }

  fun saveRejection(context: Context, caller: CallerIdentity, kind: Int? = null) {
    val existing = loadGrant(context, caller)
    val record = if (kind == null) {
      CallerGrantRecord(
        packageName = caller.packageName,
        certSha256 = caller.certSha256,
        appLabel = caller.appLabel,
        pubkeyHex = existing?.pubkeyHex ?: "",
        approved = false,
        rejected = true,
        approvedKinds = emptySet(),
        rejectedKinds = existing?.rejectedKinds ?: emptySet(),
        updatedAt = System.currentTimeMillis() / 1000L
      )
    } else {
      CallerGrantRecord(
        packageName = caller.packageName,
        certSha256 = caller.certSha256,
        appLabel = caller.appLabel,
        pubkeyHex = existing?.pubkeyHex ?: "",
        approved = existing?.approved ?: false,
        rejected = existing?.rejected ?: false,
        approvedKinds = (existing?.approvedKinds ?: emptySet()) - kind,
        rejectedKinds = (existing?.rejectedKinds ?: emptySet()) + kind,
        updatedAt = System.currentTimeMillis() / 1000L
      )
    }
    writeGrant(context, record)
  }

  private fun writeGrant(context: Context, rec: CallerGrantRecord) {
    val o = JSONObject().apply {
      put("packageName", rec.packageName)
      put("certSha256", rec.certSha256)
      put("appLabel", rec.appLabel)
      put("pubkeyHex", rec.pubkeyHex)
      put("approved", rec.approved)
      put("rejected", rec.rejected)
      put("approvedKinds", JSONArray(rec.approvedKinds.sorted()))
      put("rejectedKinds", JSONArray(rec.rejectedKinds.sorted()))
      put("updatedAt", rec.updatedAt)
    }
    context.getSharedPreferences(GRANTS_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString("${rec.packageName}|${rec.certSha256}", o.toString())
      .apply()
  }

  fun checkSignPermission(
    context: Context,
    caller: CallerIdentity,
    requestedPubkeyHex: String?,
    kind: Int
  ): SignPreAuthDecision {
    if (!hasVaultNostrKeys(context)) {
      clearAll(context)
      return SignPreAuthDecision.NotAuthorized
    }
    val rec = loadGrant(context, caller) ?: return SignPreAuthDecision.NotAuthorized
    if (rec.rejected || kind in rec.rejectedKinds) return SignPreAuthDecision.ExplicitlyRejected
    if (!rec.approved || rec.pubkeyHex.length != 64) return SignPreAuthDecision.NotAuthorized
    if (!requestedPubkeyHex.isNullOrBlank() && !rec.pubkeyHex.equals(requestedPubkeyHex, ignoreCase = true)) {
      return SignPreAuthDecision.NotAuthorized
    }
    return if (kind in rec.approvedKinds) {
      SignPreAuthDecision.Authorized(rec.pubkeyHex)
    } else {
      SignPreAuthDecision.NotAuthorized
    }
  }

  fun checkPublicKeyPermission(context: Context, caller: CallerIdentity): PubkeyPreAuthDecision {
    if (!hasVaultNostrKeys(context)) {
      clearAll(context)
      return PubkeyPreAuthDecision.NotAuthorized
    }
    val rec = loadGrant(context, caller) ?: return PubkeyPreAuthDecision.NotAuthorized
    if (rec.rejected) return PubkeyPreAuthDecision.ExplicitlyRejected
    return if (rec.approved && rec.pubkeyHex.length == 64) {
      PubkeyPreAuthDecision.Authorized(rec.pubkeyHex)
    } else {
      PubkeyPreAuthDecision.NotAuthorized
    }
  }

  // ── Vault Liveness Check & Hardware-Backed Android Keystore Seal ──

  /** Ensures RipleyOS was not wiped (e.g. duress wipe) before honoring background grants. */
  fun hasVaultNostrKeys(context: Context): Boolean {
    val kvDir = File(Nip55Bridge.appDataDir(context), "ros-kv")
    if (!kvDir.isDirectory) return false
    val skFile = File(kvDir, "ripleyos%3Achat%3Ask")
    val accFile = File(kvDir, "ripleyos%3Anostr%3Aaccounts%3Av1")
    return (skFile.isFile && skFile.length() > 0) || (accFile.isFile && accFile.length() > 0)
  }

  private fun ensureKeystoreAesKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey)?.let { return it }
    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(
      KEYSTORE_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          setUnlockedDeviceRequired(true)
        }
      }
      .build()
    kg.init(spec)
    return kg.generateKey()
  }

  /** Seal an authorized Nostr signing key inside hardware-backed Android Keystore so the
   *  background ContentProvider can silently sign pre-authorized non-restricted kinds
   *  even when RipleyOS has an OS passcode set and MainActivity is not open. */
  fun sealBackgroundKey(context: Context, pubkeyHex: String, skHex: String): Boolean {
    val plain = skHex.toByteArray(Charsets.UTF_8)
    return try {
      val key = ensureKeystoreAesKey()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key)
      val ct = cipher.doFinal(plain)
      val record = JSONObject().apply {
        put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
      }
      context.getSharedPreferences(SEALED_PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(pubkeyHex.lowercase(), record.toString())
        .apply()
      true
    } catch (_: Exception) {
      false
    } finally {
      plain.fill(0)
    }
  }

  fun <T> withUnsealedBackgroundKey(context: Context, pubkeyHex: String, block: (String) -> T): T? {
    if (!hasVaultNostrKeys(context)) {
      clearAll(context)
      return null
    }
    val prefs = context.getSharedPreferences(SEALED_PREFS, Context.MODE_PRIVATE)
    val raw = prefs.getString(pubkeyHex.lowercase(), null) ?: return null
    var plain: ByteArray? = null
    return try {
      val o = JSONObject(raw)
      val iv = Base64.decode(o.getString("iv"), Base64.NO_WRAP)
      val ct = Base64.decode(o.getString("ct"), Base64.NO_WRAP)
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey ?: return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
      plain = cipher.doFinal(ct)
      block(String(plain, Charsets.UTF_8))
    } catch (_: Exception) {
      null
    } finally {
      plain?.fill(0)
    }
  }

  // ── Native Hardware Biometric Unlock (reuses RipleyOS `ripleyos:lock:bio` + `ripley_bio_unlock_v1`) ──

  /** Inspect whether RipleyOS's native hardware biometric unlock is enabled and usable on this device. */
  fun inspectNativeBio(context: Context, nowMs: Long = System.currentTimeMillis()): NativeBioState {
    if (Build.VERSION.SDK_INT < 28) return NativeBioState.Unavailable
    val bioFile = File(File(Nip55Bridge.appDataDir(context), "ros-kv"), BIO_KV_FILE)
    if (!bioFile.isFile || bioFile.length() <= 0 || bioFile.length() > 16384) {
      return NativeBioState.Unavailable
    }
    val obj = try { JSONObject(bioFile.readText(Charsets.UTF_8)) } catch (_: Exception) {
      return NativeBioState.Unavailable
    }
    if (obj.optInt("v", 0) != 1 || obj.optString("kind", "") != "native") {
      return NativeBioState.Unavailable
    }
    val exp = obj.optLong("exp", 0L)
    if (exp <= 0L || nowMs > exp) {
      return NativeBioState.Expired
    }
    val iv = try { Base64.decode(obj.optString("salt", ""), Base64.DEFAULT) } catch (_: Exception) {
      return NativeBioState.Unavailable
    }
    val ct = try { Base64.decode(obj.optString("blob", ""), Base64.DEFAULT) } catch (_: Exception) {
      return NativeBioState.Unavailable
    }
    if (iv.size != 12 || ct.size < 17 || ct.size > 4200) {
      return NativeBioState.Unavailable
    }
    val canAuth = try {
      if (Build.VERSION.SDK_INT >= 30) {
        val bm = context.getSystemService(android.hardware.biometrics.BiometricManager::class.java)
        bm?.canAuthenticate(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG)
          ?: android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
      } else if (Build.VERSION.SDK_INT == 29) {
        val bm = context.getSystemService(android.hardware.biometrics.BiometricManager::class.java)
        @Suppress("DEPRECATION")
        bm?.canAuthenticate()
          ?: android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
      } else {
        BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      }
    } catch (_: Exception) {
      return NativeBioState.Unavailable
    }
    if (canAuth != android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS) {
      return NativeBioState.Unavailable
    }
    // Verify the hardware Keystore key still exists and hasn't been invalidated by new enrollment.
    if (initNativeBioDecryptCipher(iv) == null) {
      return NativeBioState.Unavailable
    }
    return NativeBioState.Ready(iv = iv, ct = ct)
  }

  fun initNativeBioDecryptCipher(iv: ByteArray): Cipher? {
    return try {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = ks.getKey(BIO_KEYSTORE_ALIAS, null) as? SecretKey ?: return null
      Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
      }
    } catch (_: KeyPermanentlyInvalidatedException) {
      null
    } catch (_: Exception) {
      null
    }
  }

  fun clearAll(context: Context) {
    context.getSharedPreferences(GRANTS_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    context.getSharedPreferences(SEALED_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    try {
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (ks.containsAlias(KEYSTORE_ALIAS)) ks.deleteEntry(KEYSTORE_ALIAS)
    } catch (_: Exception) { }
  }
}
