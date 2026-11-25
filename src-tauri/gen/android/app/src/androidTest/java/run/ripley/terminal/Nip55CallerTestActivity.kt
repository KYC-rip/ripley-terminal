package run.ripley.terminal

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Test-only caller Activity (lives strictly in androidTest / run.ripley.terminal.test)
 *  that invokes NostrSignerActivity via real cross-package startActivityForResult so AMS
 *  populates callingActivity.packageName = "run.ripley.terminal.test", then broadcasts the
 *  exact ActivityResult back to the instrumentation runner process. */
class Nip55CallerTestActivity : Activity() {
  companion object {
    const val EXTRA_TARGET_INTENT = "target_intent"
    const val ACTION_RESULT = "run.ripley.terminal.NIP55_TEST_RESULT"
    const val EXTRA_RESULT_CODE = "nip55_result_code"
    const val EXTRA_RESULT_DATA = "nip55_result_data"
    private const val REQ_CODE = 5501
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    @Suppress("DEPRECATION")
    val target = intent.getParcelableExtra<Intent>(EXTRA_TARGET_INTENT)
    if (target != null) {
      @Suppress("DEPRECATION")
      startActivityForResult(target, REQ_CODE)
    } else {
      finish()
    }
  }

  @Deprecated("Test helper for startActivityForResult")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == REQ_CODE) {
      val reply = Intent(ACTION_RESULT).apply {
        setPackage("run.ripley.terminal")
        putExtra(EXTRA_RESULT_CODE, resultCode)
        if (data != null) putExtra(EXTRA_RESULT_DATA, data)
      }
      sendBroadcast(reply)
      finish()
    }
  }
}
