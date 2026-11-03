package org.untitled_story.storyteller

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

object ShareHelper {
    private const val TAG = "ShareHelper"

    @JvmStatic
    fun shareFile(context: Context, path: String, mimeType: String) {
        try {
            val file = File(path)
            if (!file.exists() || !file.isFile) {
                Log.e(TAG, "File does not exist or is not a file: $path")
                throw IllegalArgumentException("File does not exist: $path")
            }

            val authority = "${context.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(context, authority, file)
            Log.i(TAG, "shareFile path=$path uri=$uri mime=$mimeType")

            val intent = Intent(Intent.ACTION_SEND).apply {
                type = if (mimeType.isBlank()) "video/mp4" else mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = android.content.ClipData.newUri(context.contentResolver, file.name, uri)
            }

            val chooser = Intent.createChooser(intent, "Share video").apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (context !is Activity) {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            context.startActivity(chooser)
        } catch (error: Exception) {
            Log.e(TAG, "Error sharing file path=$path", error)
            throw error
        }
    }
}
