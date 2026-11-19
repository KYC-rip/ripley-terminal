package run.ripley.androidpoc
import android.os.Bundle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
class MainActivity:TauriActivity(){
  private external fun nativeLock()
  private external fun nativeResume()
  override fun onResume(){super.onResume();nativeResume()}
  override fun onPause(){nativeLock();super.onPause()}
  override fun onCreate(state:Bundle?){
    super.onCreate(state)
    val content=findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content){v,i->
      val b=i.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(b.left,b.top,b.right,b.bottom);i
    }
  }
}
