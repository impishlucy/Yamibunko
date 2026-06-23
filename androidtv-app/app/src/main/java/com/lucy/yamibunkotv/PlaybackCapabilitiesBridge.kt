package com.lucy.yamibunkotv

import android.webkit.JavascriptInterface

class PlaybackCapabilitiesBridge(
    private val capabilities: VideoCodecCapabilities,
) {
    @JavascriptInterface
    fun getVideoCapabilities(): String {
        return capabilities.toJson()
    }

    @JavascriptInterface
    fun supportsVideoConfig(codec: String?, width: String?, height: String?): String {
        val mimeType = VideoCodecSupport.codecToMimeType(codec)
            ?: return HardwareDecoderSupport(
                supported = false,
                decoderName = null,
                reason = "unknown_codec",
            ).toJson()
        val parsedWidth = width?.toIntOrNull() ?: 0
        val parsedHeight = height?.toIntOrNull() ?: 0

        if (parsedWidth <= 0 || parsedHeight <= 0) {
            return HardwareDecoderSupport(
                supported = false,
                decoderName = null,
                reason = "missing_video_size",
            ).toJson()
        }

        return VideoCodecSupport.findHardwareDecoder(
            mimeType = mimeType,
            width = parsedWidth,
            height = parsedHeight,
        ).toJson()
    }
}
