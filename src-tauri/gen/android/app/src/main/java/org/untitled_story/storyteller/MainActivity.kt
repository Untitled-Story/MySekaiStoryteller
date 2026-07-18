package org.untitled_story.storyteller

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var immersiveModeEnabled: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?): Unit {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean): Unit {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && immersiveModeEnabled) {
      applyImmersiveMode(true)
    }
  }

  @SuppressLint("AddJavascriptInterface")
  override fun onWebViewCreate(webView: WebView): Unit {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(OrientationBridge(this), "MssOrientation")
  }

  private fun setImmersiveMode(enabled: Boolean): Unit {
    immersiveModeEnabled = enabled
    applyImmersiveMode(enabled)
  }

  private fun applyImmersiveMode(enabled: Boolean): Unit {
    val controller: WindowInsetsControllerCompat =
      WindowCompat.getInsetsController(window, window.decorView)

    if (enabled) {
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  private class OrientationBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun setLandscape(enabled: Boolean): Unit {
      activity.runOnUiThread {
        activity.requestedOrientation =
          if (enabled) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
          }
      }
    }

    @JavascriptInterface
    fun setImmersive(enabled: Boolean): Unit {
      activity.runOnUiThread {
        activity.setImmersiveMode(enabled)
      }
    }
  }
}
