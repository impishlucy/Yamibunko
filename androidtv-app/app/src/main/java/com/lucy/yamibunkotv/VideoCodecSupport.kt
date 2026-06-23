package com.lucy.yamibunkotv

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import java.util.Locale
import org.json.JSONObject

object VideoCodecSupport {
    private const val AV1_MIME_TYPE = "video/av01"
    private const val HEVC_MIME_TYPE = "video/hevc"
    private const val H264_MIME_TYPE = "video/avc"

    private val softwareDecoderMarkers = setOf(
        "omx.google.",
        "omx.ffmpeg.",
        "c2.android.",
        "c2.google.",
        ".sw.",
        "-sw-",
        "software",
        "ffmpeg",
        "libavcodec",
        "dav1d",
    )

    private val hardwareDecoderMarkers = setOf(
        "omx.qcom.",
        "omx.qti.",
        "omx.mtk.",
        "omx.mediatek.",
        "omx.exynos.",
        "omx.sec.",
        "omx.sprd.",
        "omx.brcm.",
        "omx.nvidia.",
        "omx.hisi.",
        "omx.hisilicon.",
        "omx.amlogic.",
        "omx.rk.",
        "omx.realtek.",
        "c2.qti.",
        "c2.qcom.",
        "c2.mtk.",
        "c2.mediatek.",
        "c2.exynos.",
        "c2.sec.",
        "c2.amlogic.",
        "c2.rk.",
        "c2.realtek.",
        "c2.nvidia.",
        "arc.",
    )

    fun detectDeviceCapabilities(): VideoCodecCapabilities {
        return VideoCodecCapabilities(
            av1 = findHardwareDecoder(AV1_MIME_TYPE),
            hevc = findHardwareDecoder(HEVC_MIME_TYPE),
            h264 = findHardwareDecoder(H264_MIME_TYPE),
        )
    }

    fun findHardwareDecoder(
        mimeType: String,
        width: Int? = null,
        height: Int? = null,
    ): HardwareDecoderSupport {
        return try {
            val decoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { codecInfo ->
                !codecInfo.isEncoder &&
                    codecInfo.supportedTypes.any { it.equals(mimeType, ignoreCase = true) } &&
                    isHardwareDecoder(codecInfo, mimeType)
            }

            if (decoders.isEmpty()) {
                return HardwareDecoderSupport(
                    supported = false,
                    decoderName = null,
                    reason = "no_hardware_decoder",
                )
            }

            val decoder = if (width != null && height != null && width > 0 && height > 0) {
                decoders.firstOrNull { codecInfo ->
                    isVideoSizeSupported(codecInfo, mimeType, width, height)
                }
            } else {
                decoders.firstOrNull()
            }

            HardwareDecoderSupport(
                supported = decoder != null,
                decoderName = decoder?.name ?: decoders.firstOrNull()?.name,
                reason = if (decoder == null) "hardware_decoder_size_unsupported" else null,
            )
        } catch (_: RuntimeException) {
            HardwareDecoderSupport(
                supported = false,
                decoderName = null,
                reason = "codec_query_failed",
            )
        }
    }

    fun codecToMimeType(codec: String?): String? {
        val normalized = codec
            ?.trim()
            ?.lowercase(Locale.ROOT)
            ?.replace(Regex("[._\\-\\s]+"), "")
            .orEmpty()

        return when {
            normalized.startsWith("av1") || normalized.startsWith("av01") -> AV1_MIME_TYPE
            normalized.startsWith("hevc") ||
                normalized.startsWith("h265") ||
                normalized.startsWith("hvc1") ||
                normalized.startsWith("hev1") -> HEVC_MIME_TYPE
            normalized.startsWith("h264") ||
                normalized.startsWith("avc") ||
                normalized.startsWith("avc1") -> H264_MIME_TYPE
            else -> null
        }
    }

    private fun isHardwareDecoder(codecInfo: MediaCodecInfo, mimeType: String): Boolean {
        val codecName = codecInfo.name.lowercase(Locale.ROOT)
        if (isSoftwareDecoder(codecName)) {
            return false
        }

        if (isBlockedDecoder(codecName, mimeType)) {
            return false
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return codecInfo.isHardwareAccelerated && !codecInfo.isSoftwareOnly
        }

        return looksLikeVendorDecoder(codecName)
    }

    private fun isVideoSizeSupported(
        codecInfo: MediaCodecInfo,
        mimeType: String,
        width: Int,
        height: Int,
    ): Boolean {
        return try {
            val videoCapabilities = codecInfo.getCapabilitiesForType(mimeType).videoCapabilities
                ?: return false

            videoCapabilities.isSizeSupported(width, height) ||
                videoCapabilities.isSizeSupported(height, width)
        } catch (_: RuntimeException) {
            false
        }
    }

    private fun isBlockedDecoder(codecName: String, mimeType: String): Boolean {
        if (mimeType != AV1_MIME_TYPE) {
            return false
        }

        return codecName.contains("amlogic") && Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q
    }

    private fun isSoftwareDecoder(codecName: String): Boolean {
        return softwareDecoderMarkers.any { marker -> codecName.contains(marker) }
    }

    private fun looksLikeVendorDecoder(codecName: String): Boolean {
        return hardwareDecoderMarkers.any { marker -> codecName.contains(marker) }
    }
}

data class VideoCodecCapabilities(
    val av1: HardwareDecoderSupport,
    val hevc: HardwareDecoderSupport,
    val h264: HardwareDecoderSupport,
) {
    val av1Hardware: Boolean get() = av1.supported
    val hevcHardware: Boolean get() = hevc.supported
    val h264Hardware: Boolean get() = h264.supported

    fun toJson(): String {
        return JSONObject()
            .put("av1Hardware", av1Hardware)
            .put("hevcHardware", hevcHardware)
            .put("h264Hardware", h264Hardware)
            .put("av1Decoder", av1.decoderName)
            .put("hevcDecoder", hevc.decoderName)
            .put("h264Decoder", h264.decoderName)
            .put("av1Reason", av1.reason)
            .put("hevcReason", hevc.reason)
            .put("h264Reason", h264.reason)
            .toString()
    }
}

data class HardwareDecoderSupport(
    val supported: Boolean,
    val decoderName: String?,
    val reason: String?,
) {
    fun toJson(): String {
        return JSONObject()
            .put("supported", supported)
            .put("decoderName", decoderName)
            .put("reason", reason)
            .toString()
    }
}
