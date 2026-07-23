package org.untitled_story.storyteller.encode

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min

/**
 * Hardware H.264 encoder used by the Rust render worker via JNI.
 * Sessions are identified by a long id; all methods are synchronized per session.
 */
object HwH264Encoder {
  private const val TAG = "HwH264Encoder"
  private const val MIME = "video/avc"
  // Non-blocking drain on the hot path; finish uses a longer wait for EOS.
  // 50ms timeouts previously inflated avg_encode_ms and serialized capture.
  private const val TIMEOUT_US = 0L
  private const val TIMEOUT_INPUT_US = 2_000L
  private const val TIMEOUT_FINISH_US = 50_000L

  private val nextId = AtomicLong(1)
  private val sessions = ConcurrentHashMap<Long, Session>()

  @JvmStatic
  fun create(path: String, width: Int, height: Int, fps: Int, bitrate: Int): Long {
    require(width >= 2 && height >= 2) { "invalid size ${width}x${height}" }
    require(fps >= 1) { "invalid fps $fps" }
    val outFile = File(path)
    outFile.parentFile?.mkdirs()
    if (outFile.exists()) {
      outFile.delete()
    }

    val w = width - (width % 2)
    val h = height - (height % 2)
    val frameRate = max(1, fps)
    val bitRate = bitrate.coerceIn(250_000, 25_000_000)
    Log.i(TAG, "create begin path=$path ${w}x${h}@$frameRate bitrate=$bitRate")

    val codecName = pickAvcEncoderName()
    var codec: MediaCodec? = null
    var muxer: MediaMuxer? = null
    try {
      codec =
        if (codecName != null) {
          Log.i(TAG, "createByCodecName $codecName")
          MediaCodec.createByCodecName(codecName)
        } else {
          Log.i(TAG, "createEncoderByType $MIME")
          MediaCodec.createEncoderByType(MIME)
        }

      var activeCodec = codec ?: throw IllegalStateException("codec null")
      val colorFormats = colorFormatCandidates(activeCodec.codecInfo)
      var started = false
      var colorFormat = colorFormats.first()
      var lastError: Throwable? = null
      for (fmt in colorFormats) {
        val format =
          MediaFormat.createVideoFormat(MIME, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, fmt)
            setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
            setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            // Avoid KEY_PROFILE/KEY_LEVEL — some OEM stacks native-crash on invalid combos.
          }
        try {
          Log.i(TAG, "configure color=$fmt")
          activeCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
          activeCodec.start()
          colorFormat = fmt
          started = true
          Log.i(TAG, "start ok color=$fmt")
          break
        } catch (t: Throwable) {
          lastError = t
          Log.w(TAG, "configure/start failed color=$fmt err=$t")
          try {
            activeCodec.reset()
          } catch (_: Throwable) {
            try {
              activeCodec.release()
            } catch (_: Throwable) {
            }
            activeCodec =
              if (codecName != null) MediaCodec.createByCodecName(codecName)
              else MediaCodec.createEncoderByType(MIME)
            codec = activeCodec
          }
        }
      }
      codec = activeCodec
      if (!started) {
        throw (lastError as? Exception)
          ?: IllegalStateException("MediaCodec configure failed: $lastError")
      }

      muxer = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val inputFmt = codec!!.inputFormat
      val stride =
        if (inputFmt.containsKey(MediaFormat.KEY_STRIDE)) {
          inputFmt.getInteger(MediaFormat.KEY_STRIDE).coerceAtLeast(w)
        } else {
          w
        }
      val sliceHeight =
        if (inputFmt.containsKey(MediaFormat.KEY_SLICE_HEIGHT)) {
          inputFmt.getInteger(MediaFormat.KEY_SLICE_HEIGHT).coerceAtLeast(h)
        } else {
          h
        }
      Log.i(TAG, "input layout stride=$stride sliceHeight=$sliceHeight color=$colorFormat")
      val session =
        Session(
          codec = codec!!,
          muxer = muxer!!,
          width = w,
          height = h,
          fps = frameRate,
          colorFormat = colorFormat,
          stride = stride,
          sliceHeight = sliceHeight,
          nv12 = ByteArray(w * h * 3 / 2)
        )
      val id = nextId.getAndIncrement()
      sessions[id] = session
      Log.i(
        TAG,
        "created id=$id path=$path ${w}x${h}@${frameRate} bitrate=$bitRate color=$colorFormat codec=${codecName ?: "default"}"
      )
      return id
    } catch (t: Throwable) {
      // Never throw across JNI — uncaught Java exceptions from native threads can kill the app.
      Log.e(TAG, "create failed: $t", t)
      try {
        muxer?.release()
      } catch (_: Throwable) {
      }
      try {
        codec?.stop()
      } catch (_: Throwable) {
      }
      try {
        codec?.release()
      } catch (_: Throwable) {
      }
      return -1L
    }
  }

  @JvmStatic
  fun encodeRgba(sessionId: Long, rgba: ByteArray, ptsUs: Long): Unit {
    val session = sessions[sessionId] ?: throw IllegalStateException("unknown session $sessionId")
    synchronized(session.lock) {
      if (session.finished) return
      val expected = session.width * session.height * 4
      if (rgba.size < expected) {
        throw IllegalArgumentException("rgba too small ${rgba.size} < $expected")
      }
      rgbaToNv12(rgba, session.width, session.height, session.nv12)
      queueInput(session, session.nv12, ptsUs, endOfStream = false)
      drainOutput(session, endOfStream = false)
    }
  }

  /** Prefer this path: caller already converted to NV12 (smaller JNI payload). */
  @JvmStatic
  fun encodeNv12(sessionId: Long, nv12: ByteArray, ptsUs: Long): Unit {
    val session = sessions[sessionId] ?: throw IllegalStateException("unknown session $sessionId")
    synchronized(session.lock) {
      if (session.finished) return
      val expected = session.width * session.height * 3 / 2
      if (nv12.size < expected) {
        throw IllegalArgumentException("nv12 too small ${nv12.size} < $expected")
      }
      if (nv12.size == session.nv12.size) {
        System.arraycopy(nv12, 0, session.nv12, 0, expected)
        queueInput(session, session.nv12, ptsUs, endOfStream = false)
      } else {
        queueInput(session, nv12, ptsUs, endOfStream = false)
      }
      drainOutput(session, endOfStream = false)
    }
  }

  @JvmStatic
  fun finish(sessionId: Long): Unit {
    val session = sessions.remove(sessionId) ?: return
    synchronized(session.lock) {
      if (session.finished) return
      try {
        queueInput(session, ByteArray(0), session.lastPtsUs + 1, endOfStream = true)
        drainOutput(session, endOfStream = true)
      } finally {
        releaseSession(session)
      }
      Log.i(TAG, "finished id=$sessionId frames=${session.frameCount} track=${session.trackIndex}")
    }
  }

  @JvmStatic
  fun destroy(sessionId: Long): Unit {
    val session = sessions.remove(sessionId) ?: return
    synchronized(session.lock) {
      releaseSession(session)
    }
  }

  private fun releaseSession(session: Session) {
    if (session.finished) return
    session.finished = true
    try {
      session.codec.stop()
    } catch (_: Exception) {
    }
    try {
      session.codec.release()
    } catch (_: Exception) {
    }
    try {
      if (session.muxerStarted) {
        session.muxer.stop()
      }
    } catch (_: Exception) {
    }
    try {
      session.muxer.release()
    } catch (_: Exception) {
    }
  }

  private fun queueInput(session: Session, nv12: ByteArray, ptsUs: Long, endOfStream: Boolean) {
    var spins = 0
    while (true) {
      val timeout = if (endOfStream) TIMEOUT_FINISH_US else TIMEOUT_INPUT_US
      val index = session.codec.dequeueInputBuffer(timeout)
      if (index >= 0) {
        val input: ByteBuffer =
          session.codec.getInputBuffer(index)
            ?: throw IllegalStateException("null input buffer")
        input.clear()
        val size =
          if (!endOfStream && nv12.isNotEmpty()) {
            copyNv12ToInput(session, input, nv12)
          } else {
            0
          }
        val flags = if (endOfStream) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
        session.codec.queueInputBuffer(index, 0, size, ptsUs, flags)
        if (!endOfStream) {
          session.lastPtsUs = ptsUs
          session.frameCount += 1
        }
        return
      }
      // No free input slot yet — non-blocking drain then retry (cap spins to avoid hang).
      drainOutput(session, endOfStream = false)
      spins += 1
      if (!endOfStream && spins > 500) {
        throw IllegalStateException("MediaCodec input buffer starvation")
      }
    }
  }

  private fun drainOutput(session: Session, endOfStream: Boolean) {
    val info = MediaCodec.BufferInfo()
    while (true) {
      val timeout = if (endOfStream) TIMEOUT_FINISH_US else TIMEOUT_US
      val outIndex = session.codec.dequeueOutputBuffer(info, timeout)
      when {
        outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
          if (!endOfStream) return
          // Keep draining until EOS if finishing.
          if (session.sawOutputEos) return
        }
        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          if (session.muxerStarted) {
            throw IllegalStateException("format changed after muxer start")
          }
          val newFormat = session.codec.outputFormat
          session.trackIndex = session.muxer.addTrack(newFormat)
          session.muxer.start()
          session.muxerStarted = true
          Log.i(TAG, "muxer started format=$newFormat")
        }
        outIndex >= 0 -> {
          val encoded =
            session.codec.getOutputBuffer(outIndex)
              ?: throw IllegalStateException("null output buffer")
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            info.size = 0
          }
          if (info.size > 0 && session.muxerStarted) {
            encoded.position(info.offset)
            encoded.limit(info.offset + info.size)
            session.muxer.writeSampleData(session.trackIndex, encoded, info)
          }
          val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          session.codec.releaseOutputBuffer(outIndex, false)
          if (eos) {
            session.sawOutputEos = true
            return
          }
        }
        else -> return
      }
      if (!endOfStream && outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
        return
      }
    }
  }

  /** Copy tightly-packed NV12 into encoder buffer respecting stride/slice-height. */
  private fun copyNv12ToInput(session: Session, input: ByteBuffer, nv12: ByteArray): Int {
    val w = session.width
    val h = session.height
    val stride = session.stride.coerceAtLeast(w)
    val sliceHeight = session.sliceHeight.coerceAtLeast(h)
    val ySrcSize = w * h
    if (stride == w && sliceHeight == h) {
      val n = min(nv12.size, ySrcSize + ySrcSize / 2)
      input.put(nv12, 0, n)
      return n
    }
    var src = 0
    for (row in 0 until h) {
      input.position(row * stride)
      input.put(nv12, src, w)
      src += w
    }
    val uvDstBase = sliceHeight * stride
    var uvSrc = ySrcSize
    val uvRows = h / 2
    for (row in 0 until uvRows) {
      input.position(uvDstBase + row * stride)
      input.put(nv12, uvSrc, w)
      uvSrc += w
    }
    return uvDstBase + uvRows * stride
  }

  private fun pickAvcEncoderName(): String? {
    val list = MediaCodecList(MediaCodecList.ALL_CODECS)
    var softPick: String? = null
    var hwPick: String? = null
    for (info in list.codecInfos) {
      if (!info.isEncoder) continue
      if (!info.supportedTypes.any { it.equals(MIME, ignoreCase = true) }) continue
      val name = info.name
      val lower = name.lowercase()
      val soft =
        lower.contains("google") ||
          lower.contains("sw") ||
          lower.contains("android.software") ||
          lower.startsWith("c2.android") ||
          lower.startsWith("omx.google")
      if (soft) {
        if (softPick == null) softPick = name
      } else if (hwPick == null) {
        hwPick = name
      }
    }
    // Emulator/goldfish: software only (no real HW; HW path is slow/flaky).
    // Real devices: prefer OEM HW (orders of magnitude faster than c2.android soft).
    val emulator =
      Build.FINGERPRINT.startsWith("generic") ||
        Build.FINGERPRINT.startsWith("unknown") ||
        Build.MODEL.contains("google_sdk") ||
        Build.MODEL.contains("Emulator") ||
        Build.MODEL.contains("Android SDK") ||
        Build.MANUFACTURER.contains("Genymotion") ||
        Build.HARDWARE.contains("goldfish") ||
        Build.HARDWARE.contains("ranchu") ||
        Build.PRODUCT.contains("sdk_gphone") ||
        Build.PRODUCT.contains("emulator") ||
        Build.PRODUCT.contains("simulator")
    val chosen =
      if (emulator) {
        softPick ?: hwPick
      } else {
        hwPick ?: softPick
      }
    Log.i(
      TAG,
      "pickAvcEncoder emulator=$emulator soft=$softPick hw=$hwPick chosen=$chosen"
    )
    return chosen
  }

  private fun colorFormatCandidates(info: MediaCodecInfo): List<Int> {
    val caps = info.getCapabilitiesForType(MIME)
    // Only semi-planar NV12-style layouts. Packed NV12 into Planar/I420 causes color cast.
    val preferred =
      listOf(
        MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar, // 21 NV12
        0x7FA30C04, // COLOR_QCOM_FormatYUV420SemiPlanar
        0x7FA30C00, // COLOR_TI_FormatYUV420PackedSemiPlanar
      )
    val out = ArrayList<Int>()
    for (fmt in preferred) {
      if (caps.colorFormats.contains(fmt)) out.add(fmt)
    }
    val flexible = MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
    if (out.isEmpty() && caps.colorFormats.contains(flexible)) {
      out.add(flexible)
    }
    if (out.isEmpty()) {
      out.add(MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar)
    }
    return out
  }

  /** BT.601 limited-range RGBA → NV12, vertical flip for WebGL bottom-up readback. */
  private fun rgbaToNv12(rgba: ByteArray, width: Int, height: Int, out: ByteArray) {
    val frame = width * height
    var yIndex = 0
    var uvIndex = frame
    for (dstRow in 0 until height) {
      val srcRow = height - 1 - dstRow
      var i = srcRow * width * 4
      for (col in 0 until width) {
        val r = rgba[i].toInt() and 0xff
        val g = rgba[i + 1].toInt() and 0xff
        val b = rgba[i + 2].toInt() and 0xff
        i += 4
        var y = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
        y = min(255, max(0, y))
        out[yIndex++] = y.toByte()
        if (dstRow % 2 == 0 && col % 2 == 0) {
          var u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
          var v = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
          u = min(255, max(0, u))
          v = min(255, max(0, v))
          out[uvIndex++] = u.toByte()
          out[uvIndex++] = v.toByte()
        }
      }
    }
  }

  private class Session(
    val codec: MediaCodec,
    val muxer: MediaMuxer,
    val width: Int,
    val height: Int,
    val fps: Int,
    val colorFormat: Int,
    val stride: Int,
    val sliceHeight: Int,
    val nv12: ByteArray,
    val lock: Any = Any(),
    var trackIndex: Int = -1,
    var muxerStarted: Boolean = false,
    var finished: Boolean = false,
    var sawOutputEos: Boolean = false,
    var lastPtsUs: Long = 0,
    var frameCount: Long = 0
  )
}
