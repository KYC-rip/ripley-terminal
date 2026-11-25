package run.ripley.terminal

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * Standard NIP-55 Android Nostr Signer Activity (`nostrsigner:` URI scheme).
 *
 * Deliberately lightweight & isolated from TauriActivity / WebView so external apps
 * (such as XMRadar Android `rip.kyc.xmradar`) get sub-100ms native approval prompts,
 * strict AMS caller package + signing certificate verification, and BIP-340 Schnorr
 * signing directly inside Ripley Terminal's Rust crypto core without ever exporting keys.
 */
class NostrSignerActivity : Activity() {
  private val cryptoExecutor = Executors.newSingleThreadExecutor()

  private var caller: CallerIdentity? = null
  private var reqType: String = ""
  private var reqId: String? = null
  private var unlockedPasscode: String? = null
  private var selectedAccountIdx: Int = 0
  private var currentVault: VaultInspection? = null

  // Request-specific parsed state
  private var requestedAllowedKinds: List<Int> = emptyList()
  private var requestedBlockedKinds: List<Int> = emptyList()
  private val kindCheckboxes = linkedMapOf<Int, CheckBox>()

  private var unsignedEventJson: String? = null
  private var parsedEventObj: JSONObject? = null
  private var requestedUserPubkey: String? = null
  private var rememberKindCb: CheckBox? = null
  private var nativeBioState: NativeBioState = NativeBioState.Unavailable
  private var bioPromptAutoAttempted: Boolean = false
  private var activeBioCancel: CancellationSignal? = null

  private lateinit var rootContainer: LinearLayout
  private lateinit var bodyContainer: LinearLayout
  private lateinit var footerContainer: LinearLayout
  private lateinit var statusText: TextView

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Never allow screenshots or Recents thumbnails of signing prompts or passcodes.
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      setRecentsScreenshotEnabled(false)
    }
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }

    reqId = intent?.getStringExtra("id")
    reqType = intent?.getStringExtra("type")?.trim()?.lowercase() ?: ""

    // Strict caller verification: must be launched via startActivityForResult with a verifiable package & cert.
    val verified = Nip55Store.resolveCallerForActivity(this)
    if (verified == null) {
      finishRejected()
      return
    }
    caller = verified

    if (reqType != "get_public_key" && reqType != "sign_event") {
      finishRejected()
      return
    }

    if (reqType == "get_public_key") {
      val (allowed, blocked) = Nip55Store.parseRequestedSignKinds(intent?.getStringExtra("permissions"))
      requestedAllowedKinds = allowed
      requestedBlockedKinds = blocked
    } else {
      val decoded = extractEventJsonFromIntent(intent)
      val obj = decoded?.let { try { JSONObject(it) } catch (_: Exception) { null } }
      if (decoded == null || obj == null || !obj.has("kind")) {
        finishRejected()
        return
      }
      unsignedEventJson = decoded
      parsedEventObj = obj
      val rawUser = intent?.getStringExtra("current_user")
      if (!rawUser.isNullOrBlank()) {
        val normalized = Nip55Bridge.normalizePubkey(rawUser)
        if (normalized == null) {
          finishRejected()
          return
        }
        requestedUserPubkey = normalized
      }
    }

    buildShellLayout()
    if (reqType == "sign_event") {
      tryAutoSignIfRemembered(verified)
    } else {
      loadVaultAsync(null)
    }
  }

  override fun onDestroy() {
    try { activeBioCancel?.cancel() } catch (_: Exception) { }
    activeBioCancel = null
    unlockedPasscode = null
    cryptoExecutor.shutdownNow()
    super.onDestroy()
  }

  @Deprecated("Legacy back for minSdk24")
  override fun onBackPressed() {
    finishRejected(persistDenial = false)
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  private fun roundedBg(fillColor: Int, strokeColor: Int = Color.TRANSPARENT, radiusDp: Int = 12): GradientDrawable =
    GradientDrawable().apply {
      setColor(fillColor)
      cornerRadius = dp(radiusDp).toFloat()
      if (strokeColor != Color.TRANSPARENT) {
        setStroke(dp(1), strokeColor)
      }
    }

  private fun buildShellLayout() {
    val bgRoot = Color.parseColor("#0B0B0F")
    rootContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(bgRoot)
    }

    val scroll = ScrollView(this).apply {
      isFillViewport = true
    }
    bodyContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(14), dp(18), dp(16))
    }
    scroll.addView(
      bodyContainer,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    )
    rootContainer.addView(
      scroll,
      LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
    )

    footerContainer = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.parseColor("#0F0F15"))
      setPadding(dp(18), dp(10), dp(18), dp(14))
      addView(View(this@NostrSignerActivity).apply {
        setBackgroundColor(Color.parseColor("#242430"))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)).apply {
          bottomMargin = dp(10)
        }
      })
    }
    rootContainer.addView(
      footerContainer,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      )
    )

    setContentView(rootContainer)
    ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }

  /** If the user already checked "Always allow" for this verified caller + kind,
   *  sign immediately (using vault or hardware Keystore seal) and return without prompting. */
  private fun tryAutoSignIfRemembered(c: CallerIdentity) {
    val ev = parsedEventObj
    val rawEventJson = unsignedEventJson
    if (ev == null || rawEventJson == null) {
      loadVaultAsync(null)
      return
    }
    val kind = ev.optInt("kind", -1)
    val decision = Nip55Store.checkSignPermission(applicationContext, c, requestedUserPubkey, kind)
    if (decision !is SignPreAuthDecision.Authorized) {
      loadVaultAsync(null)
      return
    }
    renderLoading("Signing with remembered permission…")
    cryptoExecutor.execute {
      var signed = Nip55Bridge.signWithVault(
        context = applicationContext,
        passcode = null,
        targetPubkey = decision.pubkeyHex,
        eventJson = rawEventJson
      )
      if (!signed.ok && signed.error == "LOCKED") {
        val fromKeystore = Nip55Store.withUnsealedBackgroundKey(applicationContext, decision.pubkeyHex) { skHex ->
          Nip55Bridge.signWithRawSk(skHex, decision.pubkeyHex, rawEventJson)
        }
        if (fromKeystore != null) signed = fromKeystore
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        if (signed.ok && signed.event.isNotBlank() && signed.sig.length == 128) {
          val res = Intent().apply {
            reqId?.let { putExtra("id", it) }
            putExtra("event", signed.event)
            putExtra("result", signed.sig)
            putExtra("signature", signed.sig)
          }
          setResult(RESULT_OK, res)
          finish()
        } else {
          // Sealed key missing/invalidated — fall back cleanly to normal unlock + prompt.
          loadVaultAsync(null)
        }
      }
    }
  }

  private fun loadVaultAsync(passcode: String?) {
    renderLoading(if (passcode == null) "Reading Ripley Vault…" else "Verifying passcode…")
    cryptoExecutor.execute {
      val info = Nip55Bridge.inspectVault(applicationContext, passcode)
      val bio = if (info.status == "locked" || info.status == "bad_passcode") {
        Nip55Store.inspectNativeBio(applicationContext)
      } else {
        NativeBioState.Unavailable
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        if (info.status == "ready" && passcode != null) {
          unlockedPasscode = passcode
        }
        currentVault = info
        nativeBioState = bio
        if (info.status == "ready") {
          val targetIdx = requestedUserPubkey?.let { wanted ->
            info.accounts.indexOfFirst { it.pubkey.equals(wanted, ignoreCase = true) }
          } ?: info.accounts.indexOfFirst { it.pubkey == info.activePubkey }
          selectedAccountIdx = if (targetIdx >= 0) targetIdx else 0
        }
        renderScreen()
      }
    }
  }

  private fun setFooterActions(buttonsView: View?) {
    while (footerContainer.childCount > 1) {
      footerContainer.removeViewAt(1)
    }
    if (buttonsView == null) {
      footerContainer.visibility = View.GONE
    } else {
      footerContainer.visibility = View.VISIBLE
      footerContainer.addView(buttonsView)
    }
  }

  private fun renderLoading(msg: String) {
    bodyContainer.removeAllViews()
    setFooterActions(null)
    bodyContainer.addView(headerView())
    bodyContainer.addView(TextView(this).apply {
      text = msg
      setTextColor(Color.parseColor("#A1A1AA"))
      textSize = 14f
      setPadding(0, dp(32), 0, dp(16))
      gravity = Gravity.CENTER
    })
  }

  private fun headerView(): View {
    return LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, dp(4), 0, dp(14))
      addView(TextView(this@NostrSignerActivity).apply {
        text = "RIPLEY VAULT · NIP-55 SIGNER"
        setTextColor(Color.parseColor("#FF6600"))
        textSize = 11f
        typeface = Typeface.MONOSPACE
        letterSpacing = 0.12f
      })
      addView(TextView(this@NostrSignerActivity).apply {
        text = if (reqType == "get_public_key") "Connect External App" else "Approve Nostr Signature"
        setTextColor(Color.parseColor("#F4F4F6"))
        textSize = 22f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        setPadding(0, dp(4), 0, 0)
      })
    }
  }

  private fun callerCard(c: CallerIdentity): View {
    return LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#272733"), 12)
      setPadding(dp(14), dp(12), dp(14), dp(12))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(12) }

      addView(TextView(this@NostrSignerActivity).apply {
        text = "VERIFIED CALLER"
        setTextColor(Color.parseColor("#8A8A9A"))
        textSize = 10f
        typeface = Typeface.MONOSPACE
        letterSpacing = 0.1f
      })
      addView(TextView(this@NostrSignerActivity).apply {
        text = c.appLabel
        setTextColor(Color.parseColor("#F4F4F6"))
        textSize = 16f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        setPadding(0, dp(3), 0, dp(2))
      })
      addView(TextView(this@NostrSignerActivity).apply {
        text = c.packageName
        setTextColor(Color.parseColor("#45D4E4"))
        textSize = 12f
        typeface = Typeface.MONOSPACE
      })
      addView(TextView(this@NostrSignerActivity).apply {
        text = "SHA-256  ${Nip55Store.shortFingerprint(c.certSha256)}"
        setTextColor(Color.parseColor("#7A7A8A"))
        textSize = 11f
        typeface = Typeface.MONOSPACE
        setPadding(0, dp(3), 0, 0)
      })
    }
  }

  private fun renderScreen() {
    val c = caller ?: return
    val info = currentVault ?: return
    bodyContainer.removeAllViews()
    kindCheckboxes.clear()
    rememberKindCb = null

    bodyContainer.addView(headerView())
    bodyContainer.addView(callerCard(c))

    statusText = TextView(this).apply {
      setTextColor(Color.parseColor("#FF5C72"))
      textSize = 12f
      setPadding(0, 0, 0, dp(8))
      visibility = View.GONE
    }
    if (!info.error.isNullOrBlank()) {
      statusText.text = info.error
      statusText.visibility = View.VISIBLE
    }

    when (info.status) {
      "locked", "bad_passcode" -> {
        renderUnlockCard(info.status == "bad_passcode")
        return
      }
      "no_identity" -> {
        renderNoIdentityCard()
        return
      }
      "ready" -> {
        if (reqType == "get_public_key") {
          renderGetPublicKeyBody(c, info)
        } else {
          renderSignEventBody(c, info)
        }
      }
      else -> {
        bodyContainer.addView(statusText)
        setFooterActions(actionButtonsRow("Close", null, { finishRejected(false) }, null))
      }
    }
  }

  private fun renderUnlockCard(showBadPassError: Boolean) {
    val bio = nativeBioState
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#2E2E3B"), 12)
      setPadding(dp(14), dp(14), dp(14), dp(14))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(14) }
    }
    card.addView(TextView(this).apply {
      text = "Ripley Vault is Locked"
      setTextColor(Color.parseColor("#F4F4F6"))
      textSize = 15f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    })
    card.addView(TextView(this).apply {
      text = if (bio is NativeBioState.Ready) {
        "Unlock with Fingerprint / Face ID or enter your RipleyOS passcode. Keys never leave this device."
      } else {
        "Enter your RipleyOS passcode to access your Nostr signing key. Keys never leave this device."
      }
      setTextColor(Color.parseColor("#A1A1AA"))
      textSize = 12.5f
      setPadding(0, dp(4), 0, dp(10))
    })

    if (bio is NativeBioState.Ready) {
      card.addView(Button(this).apply {
        text = "Unlock with Fingerprint / Face"
        isAllCaps = false
        setTextColor(Color.parseColor("#3DDC84"))
        textSize = 14f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        background = roundedBg(Color.parseColor("#0F241A"), Color.parseColor("#2B6A49"), 10)
        minimumHeight = dp(46)
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) }
        setOnClickListener { triggerBiometricUnlock(bio) }
      })
    } else if (bio is NativeBioState.Expired) {
      card.addView(TextView(this).apply {
        text = "Biometric unlock expired — enter your passcode to continue."
        setTextColor(Color.parseColor("#FFB020"))
        textSize = 11.5f
        setPadding(0, 0, 0, dp(8))
      })
    }

    val passInput = EditText(this).apply {
      hint = "RipleyOS passcode"
      setHintTextColor(Color.parseColor("#6E6E7A"))
      setTextColor(Color.parseColor("#F4F4F6"))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      typeface = Typeface.MONOSPACE
      textSize = 14f
      background = roundedBg(Color.parseColor("#0B0B0F"), Color.parseColor("#3B3B4D"), 8)
      setPadding(dp(12), dp(11), dp(12), dp(11))
    }
    card.addView(passInput)

    if (showBadPassError) {
      statusText.text = "Incorrect passcode. Please try again."
      statusText.visibility = View.VISIBLE
      statusText.setPadding(0, dp(8), 0, 0)
      card.addView(statusText)
    }

    bodyContainer.addView(card)
    setFooterActions(
      actionButtonsRow(
        negativeLabel = "Cancel",
        positiveLabel = "Unlock Vault",
        onNegative = { finishRejected(false) },
        onPositive = {
          val p = passInput.text?.toString() ?: ""
          if (p.isNotEmpty()) loadVaultAsync(p)
        }
      )
    )

    if (bio is NativeBioState.Ready && !showBadPassError && !bioPromptAutoAttempted) {
      bioPromptAutoAttempted = true
      window.decorView.post {
        if (!isFinishing && !isDestroyed) {
          triggerBiometricUnlock(bio)
        }
      }
    }
  }

  private fun triggerBiometricUnlock(bio: NativeBioState.Ready) {
    if (Build.VERSION.SDK_INT < 28) return
    val cipher = Nip55Store.initNativeBioDecryptCipher(bio.iv)
    if (cipher == null) {
      nativeBioState = NativeBioState.Unavailable
      renderScreen()
      return
    }
    try { activeBioCancel?.cancel() } catch (_: Exception) { }
    val cancel = CancellationSignal()
    activeBioCancel = cancel
    val exec = ContextCompat.getMainExecutor(this)
    val c = caller
    val builder = android.hardware.biometrics.BiometricPrompt.Builder(this)
      .setTitle("Unlock Ripley Vault")
      .setSubtitle(
        if (reqType == "get_public_key") {
          "Authorize ${c?.appLabel ?: "external app"}"
        } else {
          "Sign Nostr event for ${c?.appLabel ?: "external app"}"
        }
      )
      .setNegativeButton("Use passcode", exec) { _, _ -> }
    if (Build.VERSION.SDK_INT >= 30) {
      builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG)
    }
    try {
      builder.build().authenticate(
        android.hardware.biometrics.BiometricPrompt.CryptoObject(cipher),
        cancel,
        exec,
        object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult) {
            activeBioCancel = null
            var plain: ByteArray? = null
            try {
              val unlockedCipher = result.cryptoObject?.cipher ?: error("Missing crypto object")
              plain = unlockedCipher.doFinal(bio.ct)
              val pass = String(plain, Charsets.UTF_8)
              if (pass.isNotEmpty()) {
                loadVaultAsync(pass)
              }
            } catch (_: Exception) {
              nativeBioState = NativeBioState.Unavailable
              renderScreen()
            } finally {
              plain?.fill(0)
            }
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            activeBioCancel = null
            // User chose "Use passcode" or cancelled — keep the passcode card open.
          }
        }
      )
    } catch (_: Exception) {
      activeBioCancel = null
    }
  }

  private fun renderNoIdentityCard() {
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#2E2E3B"), 12)
      setPadding(dp(14), dp(14), dp(14), dp(14))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(14) }
    }
    card.addView(TextView(this).apply {
      text = "No Nostr Identity Yet"
      setTextColor(Color.parseColor("#F4F4F6"))
      textSize = 15f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    })
    card.addView(TextView(this).apply {
      text = if (reqType == "get_public_key") {
        "Create a sovereign Nostr keypair inside Ripley Vault now, or open RipleyOS Nostr to import an existing key."
      } else {
        "Open RipleyOS Nostr to create or import the Nostr key requested by this app."
      }
      setTextColor(Color.parseColor("#A1A1AA"))
      textSize = 12.5f
      setPadding(0, dp(4), 0, 0)
    })
    bodyContainer.addView(card)
    bodyContainer.addView(statusText)

    val canCreate = reqType == "get_public_key"
    setFooterActions(
      actionButtonsRow(
        negativeLabel = "Cancel",
        positiveLabel = if (canCreate) "Create Key in Vault" else null,
        onNegative = { finishRejected(false) },
        onPositive = if (canCreate) {
          {
            renderLoading("Generating sovereign keypair…")
            cryptoExecutor.execute {
              val res = Nip55Bridge.createIdentity(applicationContext)
              runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                res.onSuccess { loadVaultAsync(unlockedPasscode) }
                  .onFailure { err ->
                    currentVault = currentVault?.copy(error = err.message ?: "Failed to create key")
                    renderScreen()
                  }
              }
            }
          }
        } else null
      )
    )
  }

  private fun renderGetPublicKeyBody(c: CallerIdentity, info: VaultInspection) {
    val account = info.accounts.getOrNull(selectedAccountIdx) ?: info.accounts.firstOrNull()
    if (account == null) {
      renderNoIdentityCard()
      return
    }

    // Identity card
    val idCard = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#272733"), 12)
      setPadding(dp(14), dp(12), dp(14), dp(12))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(12) }
    }
    idCard.addView(TextView(this).apply {
      text = "RIPLEY VAULT IDENTITY"
      setTextColor(Color.parseColor("#8A8A9A"))
      textSize = 10f
      typeface = Typeface.MONOSPACE
      letterSpacing = 0.1f
    })
    idCard.addView(TextView(this).apply {
      text = account.label
      setTextColor(Color.parseColor("#3DDC84"))
      textSize = 15f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      setPadding(0, dp(3), 0, dp(2))
    })
    idCard.addView(TextView(this).apply {
      text = "${account.npub.take(18)}…${account.npub.takeLast(8)}"
      setTextColor(Color.parseColor("#E4E4EA"))
      textSize = 12f
      typeface = Typeface.MONOSPACE
    })
    idCard.addView(TextView(this).apply {
      text = "hex  ${account.pubkey.take(16)}…${account.pubkey.takeLast(8)}"
      setTextColor(Color.parseColor("#7A7A8A"))
      textSize = 11f
      typeface = Typeface.MONOSPACE
      setPadding(0, dp(2), 0, 0)
    })

    if (info.accounts.size > 1) {
      idCard.addView(Button(this).apply {
        text = "Switch Identity (${selectedAccountIdx + 1}/${info.accounts.size})"
        isAllCaps = false
        setTextColor(Color.parseColor("#F4F4F6"))
        background = roundedBg(Color.parseColor("#22222E"), Color.parseColor("#38384A"), 8)
        setPadding(dp(12), dp(6), dp(12), dp(6))
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.WRAP_CONTENT,
          LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) }
        setOnClickListener {
          selectedAccountIdx = (selectedAccountIdx + 1) % info.accounts.size
          renderScreen()
        }
      })
    }
    bodyContainer.addView(idCard)

    // Pre-authorized background kinds card
    val permCard = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#272733"), 12)
      setPadding(dp(14), dp(12), dp(14), dp(12))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(12) }
    }
    permCard.addView(TextView(this).apply {
      text = "PERMISSIONS REQUESTED"
      setTextColor(Color.parseColor("#8A8A9A"))
      textSize = 10f
      typeface = Typeface.MONOSPACE
      letterSpacing = 0.1f
    })
    permCard.addView(TextView(this).apply {
      text = "• Read your public key (npub / hex) — private key never leaves Ripley Vault."
      setTextColor(Color.parseColor("#D4D4DC"))
      textSize = 12.5f
      setPadding(0, dp(6), 0, dp(6))
    })

    if (requestedAllowedKinds.isNotEmpty()) {
      permCard.addView(TextView(this).apply {
        text = "Pre-authorized background signing (optional):"
        setTextColor(Color.parseColor("#A1A1AA"))
        textSize = 11.5f
        setPadding(0, dp(4), 0, dp(4))
      })
      for (kind in requestedAllowedKinds) {
        val cb = CheckBox(this).apply {
          text = "Kind $kind · ${Nip55Store.describeKind(kind)}"
          isChecked = true
          setTextColor(Color.parseColor("#E4E4EA"))
          textSize = 12f
          typeface = Typeface.MONOSPACE
          minHeight = dp(34)
          minimumHeight = dp(34)
          setPadding(dp(4), dp(2), dp(4), dp(2))
        }
        kindCheckboxes[kind] = cb
        permCard.addView(cb)
      }
    }

    permCard.addView(TextView(this).apply {
      text = if (requestedBlockedKinds.isNotEmpty()) {
        "Note: Public post kinds (${requestedBlockedKinds.joinToString(", ")}) are not pre-authorized on connect; you can choose Always allow when you first post."
      } else {
        "Public notes (kind 1) and articles (kind 30023) prompt on first post — you can choose Always allow for this app then."
      }
      setTextColor(Color.parseColor("#FFB020"))
      textSize = 11.5f
      setPadding(0, dp(8), 0, 0)
    })
    bodyContainer.addView(permCard)
    bodyContainer.addView(statusText)

    setFooterActions(
      actionButtonsRow(
        negativeLabel = "Reject",
        positiveLabel = "Approve & Connect",
        onNegative = {
          Nip55Store.saveRejection(applicationContext, c)
          finishRejected(persistDenial = false)
        },
        onPositive = {
          val grantedKinds = kindCheckboxes.filterValues { it.isChecked }.keys.toSet()
          approveGetPublicKey(c, account, info.hasPasscode, grantedKinds)
        }
      )
    )
  }

  private fun approveGetPublicKey(
    c: CallerIdentity,
    account: VaultAccount,
    hasPasscode: Boolean,
    grantedKinds: Set<Int>
  ) {
    renderLoading("Saving permission grant…")
    cryptoExecutor.execute {
      Nip55Store.saveApproval(
        context = applicationContext,
        caller = c,
        pubkeyHex = account.pubkey,
        kindsToApprove = grantedKinds,
        replaceKinds = true
      )
      // If the user has a passcode lock AND approved background pre-auth kinds, seal this
      // specific account key under hardware-backed Android Keystore so the background
      // ContentProvider can sign ONLY those pre-authorized kinds silently.
      if (hasPasscode && grantedKinds.isNotEmpty()) {
        val mat = Nip55Bridge.exportForKeystoreSeal(applicationContext, unlockedPasscode, account.pubkey)
        if (mat.ok) {
          Nip55Store.sealBackgroundKey(applicationContext, mat.pubkey, mat.skHex)
        }
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        val res = Intent().apply {
          putExtra("result", account.pubkey)
          putExtra("signature", account.pubkey)
          putExtra("package", packageName)
          reqId?.let { putExtra("id", it) }
        }
        setResult(RESULT_OK, res)
        finish()
      }
    }
  }

  private fun renderSignEventBody(c: CallerIdentity, info: VaultInspection) {
    val ev = parsedEventObj ?: return
    val rawEventJson = unsignedEventJson ?: return
    val kind = ev.optInt("kind", -1)
    val isHighRisk = Nip55Store.isRestrictedKind(kind)

    // Resolve target signing account; strictly fail if current_user is requested but missing from vault.
    val account = if (!requestedUserPubkey.isNullOrBlank()) {
      info.accounts.firstOrNull { it.pubkey.equals(requestedUserPubkey, ignoreCase = true) }
    } else {
      info.accounts.firstOrNull { it.pubkey == info.activePubkey } ?: info.accounts.firstOrNull()
    }

    if (account == null) {
      val errCard = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = roundedBg(Color.parseColor("#2A1217"), Color.parseColor("#FF5C72"), 12)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(14) }
      }
      errCard.addView(TextView(this).apply {
        text = "Requested Key Not Found"
        setTextColor(Color.parseColor("#FF5C72"))
        textSize = 15f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      })
      errCard.addView(TextView(this).apply {
        text = "The caller requested pubkey ${requestedUserPubkey?.take(16)}…, which is not in Ripley Vault."
        setTextColor(Color.parseColor("#F4D6DA"))
        textSize = 12.5f
        setPadding(0, dp(4), 0, 0)
      })
      bodyContainer.addView(errCard)
      setFooterActions(actionButtonsRow("Close", null, { finishRejected(false) }, null))
      return
    }

    // High-visibility warning banner for public posts (kinds 1 and 30023)
    if (isHighRisk) {
      val warn = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = roundedBg(Color.parseColor("#2A1B08"), Color.parseColor("#FF6600"), 12)
        setPadding(dp(14), dp(10), dp(14), dp(10))
        layoutParams = LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = dp(12) }
      }
      warn.addView(TextView(this).apply {
        text = if (kind == 1) "PUBLIC NOTE (KIND 1) · REVIEW CAREFULLY" else "LONG-FORM ARTICLE (KIND 30023) · REVIEW CAREFULLY"
        setTextColor(Color.parseColor("#FFB020"))
        textSize = 11f
        typeface = Typeface.MONOSPACE
        letterSpacing = 0.08f
      })
      warn.addView(TextView(this).apply {
        text = "Signed Nostr posts are public and cryptographically bound to your identity. Check below to always allow this app."
        setTextColor(Color.parseColor("#F5DFC0"))
        textSize = 12f
        setPadding(0, dp(4), 0, 0)
      })
      bodyContainer.addView(warn)
    }

    // Event details card
    val evCard = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundedBg(Color.parseColor("#14141B"), Color.parseColor("#272733"), 12)
      setPadding(dp(14), dp(12), dp(14), dp(12))
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { bottomMargin = dp(12) }
    }
    evCard.addView(TextView(this).apply {
      text = "KIND $kind · ${Nip55Store.describeKind(kind).uppercase()}"
      setTextColor(Color.parseColor("#3DDC84"))
      textSize = 11f
      typeface = Typeface.MONOSPACE
      letterSpacing = 0.08f
    })
    evCard.addView(TextView(this).apply {
      text = "Signing as ${account.label} (${account.npub.take(14)}…${account.npub.takeLast(6)})"
      setTextColor(Color.parseColor("#8A8A9A"))
      textSize = 11.5f
      typeface = Typeface.MONOSPACE
      setPadding(0, dp(3), 0, dp(8))
    })

    val tagSummary = summarizeImportantTags(ev.optJSONArray("tags"))
    if (tagSummary.isNotBlank()) {
      evCard.addView(TextView(this).apply {
        text = tagSummary
        setTextColor(Color.parseColor("#45D4E4"))
        textSize = 12f
        typeface = Typeface.MONOSPACE
        setPadding(0, 0, 0, dp(8))
      })
    }

    val contentStr = ev.optString("content", "")
    val previewBox = TextView(this).apply {
      text = if (contentStr.isBlank()) "(empty content)" else contentStr.take(1200)
      setTextColor(if (contentStr.isBlank()) Color.parseColor("#6E6E7A") else Color.parseColor("#F4F4F6"))
      textSize = 13.5f
      background = roundedBg(Color.parseColor("#0B0B0F"), Color.parseColor("#22222E"), 8)
      setPadding(dp(12), dp(10), dp(12), dp(10))
      maxLines = 14
      ellipsize = TextUtils.TruncateAt.END
    }
    evCard.addView(previewBox)

    val rawToggle = TextView(this).apply {
      text = "Show raw JSON ▾"
      setTextColor(Color.parseColor("#8A8A9A"))
      textSize = 11.5f
      typeface = Typeface.MONOSPACE
      setPadding(0, dp(8), 0, 0)
    }
    val rawBox = TextView(this).apply {
      text = try { ev.toString(2).take(2400) } catch (_: Exception) { rawEventJson.take(2400) }
      setTextColor(Color.parseColor("#A1A1AA"))
      textSize = 10.5f
      typeface = Typeface.MONOSPACE
      background = roundedBg(Color.parseColor("#08080B"), Color.parseColor("#1E1E28"), 8)
      setPadding(dp(10), dp(8), dp(10), dp(8))
      visibility = View.GONE
    }
    rawToggle.setOnClickListener {
      val show = rawBox.visibility != View.VISIBLE
      rawBox.visibility = if (show) View.VISIBLE else View.GONE
      rawToggle.text = if (show) "Hide raw JSON ▴" else "Show raw JSON ▾"
    }
    evCard.addView(rawToggle)
    evCard.addView(rawBox)

    // Allow the user to explicitly authorize this verified caller + kind forever (including kind 1 / 30023)
    // so they don't have to re-approve or re-enter passcode on every post. Unchecked by default.
    val cb = CheckBox(this).apply {
      text = "Always allow kind $kind (${Nip55Store.describeKind(kind)}) for ${c.appLabel}"
      isChecked = false
      setTextColor(Color.parseColor("#E4E4EA"))
      textSize = 12.5f
      minHeight = dp(40)
      minimumHeight = dp(40)
      setPadding(dp(4), dp(8), dp(4), dp(4))
    }
    rememberKindCb = cb
    evCard.addView(cb)

    bodyContainer.addView(evCard)
    bodyContainer.addView(statusText)

    setFooterActions(
      actionButtonsRow(
        negativeLabel = "Reject",
        positiveLabel = "Sign & Return",
        onNegative = { finishRejected(persistDenial = false) },
        onPositive = {
          val remember = rememberKindCb?.isChecked == true
          performSignEvent(c, account, info.hasPasscode, kind, rawEventJson, remember)
        }
      )
    )
  }

  private fun performSignEvent(
    c: CallerIdentity,
    account: VaultAccount,
    hasPasscode: Boolean,
    kind: Int,
    rawEventJson: String,
    rememberKind: Boolean
  ) {
    renderLoading("Signing with BIP-340 Schnorr…")
    cryptoExecutor.execute {
      val outcome = Nip55Bridge.signWithVault(
        context = applicationContext,
        passcode = unlockedPasscode,
        targetPubkey = account.pubkey,
        eventJson = rawEventJson
      )
      if (outcome.ok && rememberKind) {
        Nip55Store.saveApproval(
          context = applicationContext,
          caller = c,
          pubkeyHex = account.pubkey,
          kindsToApprove = setOf(kind),
          replaceKinds = false,
          allowExplicitRestricted = true
        )
        if (hasPasscode) {
          val mat = Nip55Bridge.exportForKeystoreSeal(applicationContext, unlockedPasscode, account.pubkey)
          if (mat.ok) Nip55Store.sealBackgroundKey(applicationContext, mat.pubkey, mat.skHex)
        }
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        if (!outcome.ok) {
          currentVault = currentVault?.copy(error = outcome.error ?: "Signing failed")
          renderScreen()
          return@runOnUiThread
        }
        val res = Intent().apply {
          reqId?.let { putExtra("id", it) }
          putExtra("event", outcome.event)
          putExtra("result", outcome.sig)
          putExtra("signature", outcome.sig)
        }
        setResult(RESULT_OK, res)
        finish()
      }
    }
  }

  private fun actionButtonsRow(
    negativeLabel: String,
    positiveLabel: String?,
    onNegative: () -> Unit,
    onPositive: (() -> Unit)?
  ): View {
    return LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      layoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
      ).apply { topMargin = dp(4) }

      addView(Button(this@NostrSignerActivity).apply {
        text = negativeLabel
        isAllCaps = false
        setTextColor(Color.parseColor("#E4E4EA"))
        textSize = 14f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        background = roundedBg(Color.parseColor("#1C1C26"), Color.parseColor("#38384A"), 10)
        minimumHeight = dp(48)
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
          if (positiveLabel != null) marginEnd = dp(10)
        }
        setOnClickListener { onNegative() }
      })

      if (positiveLabel != null && onPositive != null) {
        addView(Button(this@NostrSignerActivity).apply {
          text = positiveLabel
          isAllCaps = false
          setTextColor(Color.parseColor("#FFFFFF"))
          textSize = 14f
          typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
          background = roundedBg(Color.parseColor("#FF6600"), Color.TRANSPARENT, 10)
          minimumHeight = dp(48)
          layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.3f)
          setOnClickListener { onPositive() }
        })
      }
    }
  }

  private fun summarizeImportantTags(tags: JSONArray?): String {
    if (tags == null || tags.length() == 0) return ""
    val lines = mutableListOf<String>()
    val interesting = setOf("title", "summary", "d", "u", "method", "t", "x", "p", "e", "amount")
    for (i in 0 until tags.length()) {
      val row = tags.optJSONArray(i) ?: continue
      if (row.length() < 2) continue
      val key = row.optString(0, "")
      val value = row.optString(1, "")
      if (key in interesting && value.isNotBlank()) {
        val clipped = if (value.length > 72) "${value.take(69)}…" else value
        lines.add("$key: $clipped")
        if (lines.size >= 6) break
      }
    }
    if (tags.length() > lines.size) {
      lines.add("(${tags.length()} total tags)")
    }
    return lines.joinToString("\n")
  }

  private fun extractEventJsonFromIntent(intent: Intent?): String? {
    val rawUri = intent?.dataString ?: return null
    val colon = rawUri.indexOf(':')
    if (colon < 0) return null
    val scheme = rawUri.substring(0, colon).lowercase()
    if (scheme != "nostrsigner") return null
    val rawPayload = rawUri.substring(colon + 1)
    if (rawPayload.isBlank()) return null

    // 1. Already valid raw JSON
    val trimmed = rawPayload.trim()
    if (trimmed.startsWith("{") && isJsonObject(trimmed)) return trimmed

    // 2. Standard RFC-3986 percent-decoding (preserves literal '+' inside text/base64)
    val uriDecoded = try { Uri.decode(rawPayload).trim() } catch (_: Exception) { "" }
    if (uriDecoded.startsWith("{") && isJsonObject(uriDecoded)) return uriDecoded

    // 3. Fallback for application/x-www-form-urlencoded (URLEncoder '+' -> space)
    val formDecoded = try { URLDecoder.decode(rawPayload, "UTF-8").trim() } catch (_: Exception) { "" }
    if (formDecoded.startsWith("{") && isJsonObject(formDecoded)) return formDecoded

    return null
  }

  private fun isJsonObject(candidate: String): Boolean {
    return try {
      JSONObject(candidate)
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun finishRejected(persistDenial: Boolean = false) {
    if (persistDenial) {
      caller?.let { Nip55Store.saveRejection(applicationContext, it) }
    }
    val data = Intent().apply {
      putExtra("rejected", true)
      reqId?.let { putExtra("id", it) }
    }
    setResult(RESULT_CANCELED, data)
    finish()
  }
}
