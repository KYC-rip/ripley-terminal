package run.ripley.terminal

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class Nip55InstrumentedTest {
  private lateinit var ctx: Context
  private lateinit var selfCaller: CallerIdentity
  private lateinit var testPubkeyHex: String
  private var createdRosKvFiles = false

  @Before
  fun setUp() {
    ctx = InstrumentationRegistry.getInstrumentation().targetContext
    Nip55Store.clearAll(ctx)

    val cert = Nip55Store.computeSigningCertSha256(ctx, ctx.packageName)
    assertNotNull("Expected signing cert SHA-256 for app package", cert)
    selfCaller = CallerIdentity(ctx.packageName, cert!!, "Ripley Test Caller")

    val info = Nip55Bridge.inspectVault(ctx, null)
    testPubkeyHex = if (info.status == "ready" && info.activePubkey != null) {
      info.activePubkey!!
    } else {
      val created = Nip55Bridge.createIdentity(ctx).getOrThrow()
      createdRosKvFiles = true
      created.pubkey
    }
    assertEquals(64, testPubkeyHex.length)
  }

  @After
  fun tearDown() {
    Nip55Store.clearAll(ctx)
    if (createdRosKvFiles) {
      val kvDir = File(Nip55Bridge.appDataDir(ctx), "ros-kv")
      File(kvDir, "ripleyos%3Achat%3Ask").delete()
      File(kvDir, "ripleyos%3Anostr%3Aaccounts%3Av1").delete()
      File(kvDir, "ripleyos%3Anostr%3Aactive").delete()
    }
  }

  @Test
  fun manifestExposesNostrSignerIntentFilter() {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
      addCategory(Intent.CATEGORY_DEFAULT)
      addCategory(Intent.CATEGORY_BROWSABLE)
    }
    val matches = ctx.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
    assertTrue(
      "Expected NostrSignerActivity to handle nostrsigner: VIEW/DEFAULT/BROWSABLE",
      matches.any {
        it.activityInfo.packageName == ctx.packageName &&
          it.activityInfo.name == "${ctx.packageName}.NostrSignerActivity"
      }
    )
  }

  @Test
  fun parsePermissionsStripsRestrictedKinds1And30023() {
    val xmradarKinds = listOf(0, 5, 17, 9042, 9044, 10002, 10011, 10133, 24242, 27235)
    val perms = JSONArray()
    for (k in xmradarKinds + listOf(1, 30023)) {
      perms.put(JSONObject().put("type", "sign_event").put("kind", k))
    }
    val (allowed, blocked) = Nip55Store.parseRequestedSignKinds(perms.toString())
    assertEquals(xmradarKinds, allowed)
    assertEquals(listOf(1, 30023), blocked)
  }

  @Test
  fun contentProviderSignsPreAuthorizedKindsAndNeverAutoSigns1Or30023() {
    val signUri = Uri.parse("content://${ctx.packageName}.SIGN_EVENT")
    val pkUri = Uri.parse("content://${ctx.packageName}.GET_PUBLIC_KEY")
    val blossomEvent = JSONObject()
      .put("kind", 24242)
      .put("created_at", 1700000000L)
      .put("tags", JSONArray().put(JSONArray().put("t").put("upload")))
      .put("content", "Upload blob")
      .toString()

    // 1. Before approval -> empty cursor for both SIGN_EVENT and GET_PUBLIC_KEY
    ctx.contentResolver.query(signUri, arrayOf(blossomEvent, "", testPubkeyHex), null, null, null).use { c ->
      assertNotNull(c)
      assertEquals(0, c!!.count)
    }
    ctx.contentResolver.query(pkUri, null, null, null, null).use { c ->
      assertNotNull(c)
      assertEquals(0, c!!.count)
    }

    // 2. Grant XMRadar's 10 background kinds (attempting to sneak in 1 and 30023 must be ignored)
    val requested = listOf(0, 1, 5, 17, 9042, 9044, 10002, 10011, 10133, 24242, 27235, 30023)
    Nip55Store.saveApproval(ctx, selfCaller, testPubkeyHex, requested, replaceKinds = true)

    // 3. GET_PUBLIC_KEY returns 64-hex pubkey
    ctx.contentResolver.query(pkUri, null, null, null, null).use { c ->
      assertNotNull(c)
      assertTrue(c!!.moveToFirst())
      assertEquals(testPubkeyHex, c.getString(c.getColumnIndexOrThrow("result")))
    }

    // 4. Pre-authorized kinds (24242 Blossom, 27235 NIP-98, 9042 XMRadar) sign cleanly
    for (k in listOf(24242, 27235, 9042)) {
      val evJson = JSONObject()
        .put("kind", k)
        .put("created_at", 1700000123L)
        .put("tags", JSONArray())
        .put("content", "kind-$k-payload")
        .toString()
      ctx.contentResolver.query(signUri, arrayOf(evJson, "", testPubkeyHex), null, null, null).use { c ->
        assertNotNull(c)
        assertTrue("Expected signed row for kind $k", c!!.moveToFirst())
        val signedEventStr = c.getString(c.getColumnIndexOrThrow("event"))
        val sigHex = c.getString(c.getColumnIndexOrThrow("result"))
        assertEquals(128, sigHex.length)
        val signedObj = JSONObject(signedEventStr)
        assertEquals(testPubkeyHex, signedObj.getString("pubkey"))
        assertEquals(k, signedObj.getInt("kind"))
        assertEquals(1700000123L, signedObj.getLong("created_at"))
        assertEquals("kind-$k-payload", signedObj.getString("content"))
        assertEquals(sigHex, signedObj.getString("sig"))
        assertEquals(64, signedObj.getString("id").length)
      }
    }

    // 5. Kinds 1 and 30023 MUST NOT be auto-signed by default -> empty cursor
    for (restrictedKind in listOf(1, 30023)) {
      val evJson = JSONObject()
        .put("kind", restrictedKind)
        .put("created_at", 1700000123L)
        .put("tags", JSONArray())
        .put("content", "public post must prompt by default")
        .toString()
      ctx.contentResolver.query(signUri, arrayOf(evJson, "", testPubkeyHex), null, null, null).use { c ->
        assertNotNull(c)
        assertEquals("Kind $restrictedKind must NOT auto-sign before explicit opt-in", 0, c!!.count)
      }
    }

    // 5b. Once user explicitly opts into "Always allow kind 1" interactively, ContentProvider signs kind 1 silently
    Nip55Store.saveApproval(
      context = ctx,
      caller = selfCaller,
      pubkeyHex = testPubkeyHex,
      kindsToApprove = setOf(1),
      replaceKinds = false,
      allowExplicitRestricted = true
    )
    val k1Json = JSONObject()
      .put("kind", 1)
      .put("created_at", 1700000456L)
      .put("tags", JSONArray())
      .put("content", "remembered kind 1 post")
      .toString()
    ctx.contentResolver.query(signUri, arrayOf(k1Json, "", testPubkeyHex), null, null, null).use { c ->
      assertNotNull(c)
      assertTrue("Expected kind 1 to sign silently after explicit opt-in", c!!.moveToFirst())
      assertEquals(128, c.getString(c.getColumnIndexOrThrow("result")).length)
      assertEquals(1, JSONObject(c.getString(c.getColumnIndexOrThrow("event"))).getInt("kind"))
    }
    // Kind 30023 still requires its own opt-in
    val k30023Json = JSONObject().put("kind", 30023).put("tags", JSONArray()).put("content", "article").toString()
    ctx.contentResolver.query(signUri, arrayOf(k30023Json, "", testPubkeyHex), null, null, null).use { c ->
      assertNotNull(c)
      assertEquals("Kind 30023 must remain unapproved until opted in", 0, c!!.count)
    }

    // 6. Mismatched pubkey -> empty cursor
    val wrongPubkey = "0".repeat(64)
    ctx.contentResolver.query(signUri, arrayOf(blossomEvent, "", wrongPubkey), null, null, null).use { c ->
      assertNotNull(c)
      assertEquals(0, c!!.count)
    }

    // 7. Explicit rejection on kind 5 -> returns 1-row cursor with rejected="true"
    Nip55Store.saveRejection(ctx, selfCaller, kind = 5)
    val delEvent = JSONObject().put("kind", 5).put("tags", JSONArray()).put("content", "").toString()
    ctx.contentResolver.query(signUri, arrayOf(delEvent, "", testPubkeyHex), null, null, null).use { c ->
      assertNotNull(c)
      assertTrue(c!!.moveToFirst())
      assertEquals("true", c.getString(c.getColumnIndexOrThrow("rejected")))
    }
  }

  @Test
  fun keystoreBackgroundSealRoundTripSignsValidEvent() {
    val mat = Nip55Bridge.exportForKeystoreSeal(ctx, null, testPubkeyHex)
    assertTrue("Expected keystore seal material", mat.ok)
    assertEquals(testPubkeyHex, mat.pubkey)
    assertTrue(Nip55Store.sealBackgroundKey(ctx, mat.pubkey, mat.skHex))

    val signed = Nip55Store.withUnsealedBackgroundKey(ctx, testPubkeyHex) { skHex ->
      Nip55Bridge.signWithRawSk(
        skHex = skHex,
        expectedPubkey = testPubkeyHex,
        eventJson = """{"kind":27235,"created_at":1700000500,"tags":[["method","GET"]],"content":""}"""
      )
    }
    assertNotNull(signed)
    assertTrue(signed!!.ok)
    assertEquals(testPubkeyHex, signed.pubkey)
    assertEquals(128, signed.sig.length)
    assertFalse(signed.event.isBlank())
  }

  // ── Live Interactive NostrSignerActivity Tests (real startActivityForResult) ──

  @Test
  fun interactiveGetPublicKeyApprovesAndEnablesBackgroundSigning() {
    val xmradarKinds = listOf(0, 5, 17, 9042, 9044, 10002, 10011, 10133, 24242, 27235)
    val perms = JSONArray().apply {
      xmradarKinds.forEach { put(JSONObject().put("type", "sign_event").put("kind", it)) }
    }
    val signerIntent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
      setPackage(ctx.packageName)
      putExtra("type", "get_public_key")
      putExtra("permissions", perms.toString())
    }

    val (signerActivity, pendingResult) = launchViaCaller(signerIntent)
    val approveBtn = waitForButton(signerActivity, "Approve & Connect")
    val views = collectViews(signerActivity)
    val checkboxes = views.filterIsInstance<CheckBox>()
    assertEquals("Expected all 10 pre-auth kind checkboxes", 10, checkboxes.size)
    assertTrue("All 10 requested kinds should default checked", checkboxes.all { it.isChecked })

    saveActivitySnapshot(signerActivity, "nip55_get_public_key.png")

    InstrumentationRegistry.getInstrumentation().runOnMainSync { approveBtn.performClick() }
    val (resultCode, data) = pendingResult.await()
    assertEquals(Activity.RESULT_OK, resultCode)
    assertNotNull(data)
    assertEquals(testPubkeyHex, data!!.getStringExtra("result"))
    assertEquals(ctx.packageName, data.getStringExtra("package"))

    // Verify all 10 XMRadar background kinds were persisted under the verified caller (packageName + certSha256)
    val testCtx = InstrumentationRegistry.getInstrumentation().context
    val callerCert = Nip55Store.computeSigningCertSha256(ctx, testCtx.packageName)
    assertNotNull(callerCert)
    val testCaller = CallerIdentity(testCtx.packageName, callerCert!!, "Test")
    val grant = Nip55Store.loadGrant(ctx, testCaller)
    assertNotNull("Expected persisted grant for verified caller ${testCtx.packageName}", grant)
    assertTrue(grant!!.approved)
    assertEquals(testPubkeyHex, grant.pubkeyHex)
    assertEquals(xmradarKinds.toSet(), grant.approvedKinds)
    assertFalse(1 in grant.approvedKinds)
    assertFalse(30023 in grant.approvedKinds)
  }

  @Test
  fun interactiveSignEventKind1ShowsWarningEchoesIdAndSigns() {
    val reqUuid = "xmradar-req-uuid-9f8e7d6c"
    val unsigned = JSONObject()
      .put("kind", 1)
      .put("created_at", 1700001111L)
      .put("tags", JSONArray().put(JSONArray().put("t").put("monero")))
      .put("content", "Testing sovereign NIP-55 signing from Ripley Vault on Android.")
      .toString()
    val signerIntent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:${Uri.encode(unsigned)}")).apply {
      setPackage(ctx.packageName)
      putExtra("type", "sign_event")
      putExtra("current_user", testPubkeyHex)
      putExtra("id", reqUuid)
    }

    val (signerActivity, pendingResult) = launchViaCaller(signerIntent)
    val signBtn = waitForButton(signerActivity, "Sign & Return")
    val views = collectViews(signerActivity)
    val allText = views.filterIsInstance<TextView>().joinToString("\n") { it.text?.toString() ?: "" }
    assertTrue("Expected kind 1 public note warning banner", allText.contains("PUBLIC NOTE (KIND 1)"))
    assertTrue("Expected event content preview", allText.contains("Testing sovereign NIP-55 signing"))
    val rememberCbs = views.filterIsInstance<CheckBox>()
    assertEquals("Expected explicit opt-in checkbox for kind 1", 1, rememberCbs.size)
    assertFalse("Always-allow checkbox for kind 1 must default unchecked", rememberCbs[0].isChecked)
    assertTrue("Checkbox label should mention Always allow kind 1", rememberCbs[0].text.toString().contains("Always allow kind 1"))

    saveActivitySnapshot(signerActivity, "nip55_sign_event_k1.png")

    // Check "Always allow kind 1" and sign -> next kind 1 intent from same caller auto-signs immediately
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      rememberCbs[0].isChecked = true
      signBtn.performClick()
    }
    val (resultCode, data) = pendingResult.await()
    assertEquals(Activity.RESULT_OK, resultCode)
    assertNotNull(data)
    assertEquals("Exact request UUID must be echoed", reqUuid, data!!.getStringExtra("id"))
    val sig = data.getStringExtra("result")
    val signedEventJson = data.getStringExtra("event")
    assertNotNull(sig)
    assertEquals(128, sig!!.length)
    assertNotNull(signedEventJson)
    val ev = JSONObject(signedEventJson!!)
    assertEquals(testPubkeyHex, ev.getString("pubkey"))
    assertEquals(1, ev.getInt("kind"))
    assertEquals(sig, ev.getString("sig"))
    assertEquals(64, ev.getString("id").length)

    // Second kind 1 intent from the SAME verified caller should auto-sign with zero interaction!
    val secondUuid = "xmradar-req-uuid-auto-2"
    val secondIntent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:${Uri.encode(unsigned)}")).apply {
      setPackage(ctx.packageName)
      putExtra("type", "sign_event")
      putExtra("current_user", testPubkeyHex)
      putExtra("id", secondUuid)
    }
    val pendingAuto = PendingActivityResult()
    val testCtx = InstrumentationRegistry.getInstrumentation().context
    val launcher = Intent(testCtx, Nip55CallerTestActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(Nip55CallerTestActivity.EXTRA_TARGET_INTENT, secondIntent)
    }
    testCtx.startActivity(launcher)
    val (autoCode, autoData) = pendingAuto.await()
    assertEquals("Expected remembered kind 1 to auto-sign without prompt", Activity.RESULT_OK, autoCode)
    assertNotNull(autoData)
    assertEquals(secondUuid, autoData!!.getStringExtra("id"))
    assertEquals(128, autoData.getStringExtra("result")?.length)
  }

  @Test
  fun inspectNativeBioDetectsMissingAndExpiredRecords() {
    val kvDir = File(Nip55Bridge.appDataDir(ctx), "ros-kv").apply { mkdirs() }
    val bioFile = File(kvDir, "ripleyos%3Alock%3Abio")
    val backup = if (bioFile.isFile) bioFile.readBytes() else null
    try {
      bioFile.delete()
      assertTrue(Nip55Store.inspectNativeBio(ctx) is NativeBioState.Unavailable)

      val expired = JSONObject()
        .put("v", 1)
        .put("kind", "native")
        .put("cred", "android-keystore-v1")
        .put("salt", "AAAAAAAAAAAAAAAA")
        .put("blob", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
        .put("exp", 1000L)
        .toString()
      bioFile.writeText(expired)
      assertTrue(Nip55Store.inspectNativeBio(ctx) is NativeBioState.Expired)
    } finally {
      if (backup != null) bioFile.writeBytes(backup) else bioFile.delete()
    }
  }

  @Test
  fun interactiveSignEventKind30023RejectReturnsCanceledAndRejectedTrue() {
    val reqUuid = "xmradar-article-reject-42"
    val unsigned = JSONObject()
      .put("kind", 30023)
      .put("created_at", 1700002222L)
      .put("tags", JSONArray().put(JSONArray().put("title").put("Zero-KYC Field Notes")))
      .put("content", "# Draft article body")
      .toString()
    val signerIntent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:${Uri.encode(unsigned)}")).apply {
      setPackage(ctx.packageName)
      putExtra("type", "sign_event")
      putExtra("current_user", testPubkeyHex)
      putExtra("id", reqUuid)
    }

    val (signerActivity, pendingResult) = launchViaCaller(signerIntent)
    val rejectBtn = waitForButton(signerActivity, "Reject")
    val views = collectViews(signerActivity)
    val allText = views.filterIsInstance<TextView>().joinToString("\n") { it.text?.toString() ?: "" }
    assertTrue("Expected kind 30023 warning banner", allText.contains("LONG-FORM ARTICLE (KIND 30023)"))
    assertTrue("Expected article title tag summary", allText.contains("Zero-KYC Field Notes"))

    InstrumentationRegistry.getInstrumentation().runOnMainSync { rejectBtn.performClick() }
    val (resultCode, data) = pendingResult.await()
    assertEquals(Activity.RESULT_CANCELED, resultCode)
    assertNotNull(data)
    assertTrue("Expected rejected=true extra", data!!.getBooleanExtra("rejected", false))
    assertEquals("Exact request UUID must be echoed on reject", reqUuid, data.getStringExtra("id"))
  }

  private inner class PendingActivityResult {
    private val latch = CountDownLatch(1)
    @Volatile private var code: Int = Integer.MIN_VALUE
    @Volatile private var payload: Intent? = null
    private val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != Nip55CallerTestActivity.ACTION_RESULT) return
        code = intent.getIntExtra(Nip55CallerTestActivity.EXTRA_RESULT_CODE, Integer.MIN_VALUE)
        @Suppress("DEPRECATION")
        payload = intent.getParcelableExtra(Nip55CallerTestActivity.EXTRA_RESULT_DATA)
        latch.countDown()
      }
    }

    init {
      val filter = IntentFilter(Nip55CallerTestActivity.ACTION_RESULT)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        ctx.registerReceiver(receiver, filter)
      }
    }

    fun await(timeoutSec: Long = 15): Pair<Int, Intent?> {
      try {
        assertTrue("Timed out waiting for cross-package ActivityResult", latch.await(timeoutSec, TimeUnit.SECONDS))
        return code to payload
      } finally {
        try { ctx.unregisterReceiver(receiver) } catch (_: Exception) { }
      }
    }
  }

  private fun launchViaCaller(target: Intent): Pair<NostrSignerActivity, PendingActivityResult> {
    val pending = PendingActivityResult()
    val testCtx = InstrumentationRegistry.getInstrumentation().context
    val launcher = Intent(testCtx, Nip55CallerTestActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      putExtra(Nip55CallerTestActivity.EXTRA_TARGET_INTENT, target)
    }
    testCtx.startActivity(launcher)

    val deadline = System.currentTimeMillis() + 10_000
    while (System.currentTimeMillis() < deadline) {
      var found: NostrSignerActivity? = null
      InstrumentationRegistry.getInstrumentation().runOnMainSync {
        val resumed = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
        found = resumed.filterIsInstance<NostrSignerActivity>().firstOrNull()
      }
      if (found != null) return found!! to pending
      Thread.sleep(100)
    }
    throw AssertionError("NostrSignerActivity did not reach RESUMED state")
  }

  private fun waitForButton(activity: Activity, label: String): Button {
    val deadline = System.currentTimeMillis() + 8_000
    while (System.currentTimeMillis() < deadline) {
      var found: Button? = null
      InstrumentationRegistry.getInstrumentation().runOnMainSync {
        found = collectViewsOnUi(activity.window.decorView)
          .filterIsInstance<Button>()
          .firstOrNull { it.text?.toString() == label && it.visibility == View.VISIBLE }
      }
      if (found != null) return found!!
      Thread.sleep(100)
    }
    throw AssertionError("Button '$label' not found in NostrSignerActivity")
  }

  private fun collectViews(activity: Activity): List<View> {
    var out: List<View> = emptyList()
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      out = collectViewsOnUi(activity.window.decorView)
    }
    return out
  }

  private fun collectViewsOnUi(root: View): List<View> {
    val out = mutableListOf(root)
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        out.addAll(collectViewsOnUi(root.getChildAt(i)))
      }
    }
    return out
  }

  private fun saveActivitySnapshot(activity: Activity, fileName: String) {
    Thread.sleep(250)
    val outDir = ctx.getExternalFilesDir(null) ?: return
    val outFile = File(outDir, fileName)
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val v = activity.window.decorView
      if (v.width > 0 && v.height > 0) {
        val bmp = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        v.draw(canvas)
        FileOutputStream(outFile).use { fos -> bmp.compress(Bitmap.CompressFormat.PNG, 100, fos) }
        bmp.recycle()
      }
    }
  }
}
