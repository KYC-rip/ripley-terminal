package run.ripley.terminal

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import org.json.JSONObject

/**
 * Standard NIP-55 Background ContentProvider (`${applicationId}.SIGN_EVENT` and
 * `${applicationId}.GET_PUBLIC_KEY`).
 *
 * Silently signs pre-authorized non-restricted Nostr event kinds (e.g. XMRadar's
 * xo/xap/Blossom kinds 0, 5, 17, 9042, 9044, 10002, 10011, 10133, 24242, 27235)
 * after verifying the caller's Binder UID, package name, and APK signing certificate
 * SHA-256 digest against saved grants.
 *
 * Security invariants:
 *  - Kinds 1 (public note) and 30023 (long-form article) are NEVER auto-signed.
 *  - Unauthorized callers or non-pre-authorized kinds receive an empty cursor so the
 *    caller cleanly falls back to the interactive `nostrsigner:` Activity Intent.
 *  - Explicitly rejected callers/kinds receive a 1-row cursor with `rejected="true"`.
 */
class NostrSignerContentProvider : ContentProvider() {
  companion object {
    private const val MAX_EVENT_BYTES = 256 * 1024
  }

  override fun onCreate(): Boolean = true

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?
  ): Cursor {
    val ctx = context ?: return emptySignCursor()
    val authority = uri.authority ?: return emptySignCursor()
    val signAuthority = "${ctx.packageName}.SIGN_EVENT"
    val pkAuthority = "${ctx.packageName}.GET_PUBLIC_KEY"

    // Authenticate caller via Binder.getCallingUid() + callingPackage + APK signing certificate digest.
    val caller = Nip55Store.resolveCallerForProvider(ctx, callingPackage)
      ?: return emptySignCursor()

    return when (authority) {
      signAuthority -> handleSignEvent(ctx, caller, projection)
      pkAuthority -> handleGetPublicKey(ctx, caller)
      else -> emptySignCursor()
    }
  }

  private fun handleGetPublicKey(ctx: android.content.Context, caller: CallerIdentity): Cursor {
    return when (val decision = Nip55Store.checkPublicKeyPermission(ctx, caller)) {
      is PubkeyPreAuthDecision.Authorized -> {
        MatrixCursor(arrayOf("result", "signature")).apply {
          addRow(arrayOf(decision.pubkeyHex, decision.pubkeyHex))
        }
      }
      is PubkeyPreAuthDecision.ExplicitlyRejected -> rejectedCursor()
      is PubkeyPreAuthDecision.NotAuthorized -> MatrixCursor(arrayOf("result"))
    }
  }

  private fun handleSignEvent(
    ctx: android.content.Context,
    caller: CallerIdentity,
    projection: Array<out String>?
  ): Cursor {
    val eventJson = projection?.getOrNull(0)?.trim()
    if (eventJson.isNullOrBlank() || eventJson.length > MAX_EVENT_BYTES) {
      return emptySignCursor()
    }

    val kind = try {
      val obj = JSONObject(eventJson)
      if (!obj.has("kind")) return emptySignCursor()
      obj.getInt("kind")
    } catch (_: Exception) {
      return emptySignCursor()
    }

    // Hardcoded invariant: NEVER auto-sign kinds 1 or 30023 in the background.
    if (Nip55Store.isRestrictedKind(kind)) {
      return emptySignCursor()
    }

    // XMRadar passes projection = [eventJson, "", pubkeyHex]; also accept [eventJson, pubkeyHex].
    val rawPubkey = projection.getOrNull(2)?.takeIf { it.isNotBlank() }
      ?: projection.getOrNull(1)?.takeIf { it.isNotBlank() }
    val targetPubkeyHex = if (rawPubkey != null) {
      Nip55Bridge.normalizePubkey(rawPubkey) ?: return emptySignCursor()
    } else {
      null
    }

    val decision = Nip55Store.checkSignPermission(ctx, caller, targetPubkeyHex, kind)
    val authorizedPubkey = when (decision) {
      is SignPreAuthDecision.Authorized -> decision.pubkeyHex
      is SignPreAuthDecision.ExplicitlyRejected -> return rejectedCursor()
      is SignPreAuthDecision.NotAuthorized -> return emptySignCursor()
    }

    // 1. Try direct vault signing (works immediately for passcode-less vaults).
    var signed = Nip55Bridge.signWithVault(
      context = ctx,
      passcode = null,
      targetPubkey = authorizedPubkey,
      eventJson = eventJson
    )

    // 2. If RipleyOS has an OS passcode set, fall back to the hardware-backed Android Keystore
    //    entry sealed when the user explicitly approved these background permissions.
    if (!signed.ok && signed.error == "LOCKED") {
      val fromKeystore = Nip55Store.withUnsealedBackgroundKey(ctx, authorizedPubkey) { skHex ->
        Nip55Bridge.signWithRawSk(skHex, authorizedPubkey, eventJson)
      }
      if (fromKeystore != null) {
        signed = fromKeystore
      }
    }

    if (!signed.ok || signed.event.isBlank() || signed.sig.length != 128) {
      // Fail closed with empty cursor so caller can fall back to interactive Intent.
      return emptySignCursor()
    }

    return MatrixCursor(arrayOf("event", "result", "signature")).apply {
      addRow(arrayOf(signed.event, signed.sig, signed.sig))
    }
  }

  private fun emptySignCursor(): MatrixCursor = MatrixCursor(arrayOf("event", "result"))

  private fun rejectedCursor(): MatrixCursor =
    MatrixCursor(arrayOf("rejected")).apply { addRow(arrayOf("true")) }

  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?
  ): Int = 0
}
