package org.untitled_story.storyteller

import android.annotation.SuppressLint
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  @SuppressLint("AddJavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(OrientationBridge(this), "MssOrientation")
  }

  private class OrientationBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun setLandscape(enabled: Boolean) {
      activity.runOnUiThread {
        activity.requestedOrientation =
          if (enabled) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
          }
      }
    }
  }
}
