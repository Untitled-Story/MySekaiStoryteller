package org.untitled_story.storyteller

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var immersiveModeEnabled: Boolean = false

  companion object {
    init {
      // Ensure native symbols resolve for mssInstallJavaVm (lib already loaded by Tauri).
    }

    @JvmStatic
    private external fun mssInstallJavaVm()
  }

  override fun onCreate(savedInstanceState: Bundle?): Unit {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    try {
      mssInstallJavaVm()
    } catch (error: Throwable) {
      android.util.Log.e("MainActivity", "mssInstallJavaVm failed: $error")
    }
    applySystemBarVisibility()
  }

  override fun onConfigurationChanged(newConfig: Configuration): Unit {
    super.onConfigurationChanged(newConfig)
    applySystemBarVisibility()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean): Unit {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      applySystemBarVisibility()
    }
  }

  @SuppressLint("AddJavascriptInterface")
  override fun onWebViewCreate(webView: WebView): Unit {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(OrientationBridge(this), "MssOrientation")
  }

  private fun setImmersiveMode(enabled: Boolean): Unit {
    immersiveModeEnabled = enabled
    applySystemBarVisibility()
  }

  private fun applySystemBarVisibility(): Unit {
    val controller: WindowInsetsControllerCompat =
      WindowCompat.getInsetsController(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

    if (immersiveModeEnabled) {
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
      controller.show(WindowInsetsCompat.Type.navigationBars())
      controller.hide(WindowInsetsCompat.Type.statusBars())
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
