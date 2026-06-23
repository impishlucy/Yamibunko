package com.lucy.yamibunkotv

object YamibunkoUserAgent {
    fun build(currentUserAgent: String?, capabilities: VideoCodecCapabilities): String {
        val baseUserAgent = currentUserAgent.orEmpty().trim()
        val appTokens = buildAppTokens(capabilities)

        return when {
            baseUserAgent.isEmpty() -> appTokens
            baseUserAgent.contains("YamibunkoTV-WebView", ignoreCase = true) -> {
                appendMissingTokens(baseUserAgent, appTokens)
            }
            baseUserAgent.contains("YamibunkoTV", ignoreCase = true) -> {
                appendMissingTokens("$baseUserAgent YamibunkoTV-WebView/1.0", appTokens)
            }
            else -> "$baseUserAgent $appTokens"
        }
    }

    private fun buildAppTokens(capabilities: VideoCodecCapabilities): String {
        val av1Token = if (capabilities.av1Hardware) "YamibunkoAV1HW/1" else "YamibunkoAV1HW/0"
        val hevcToken = if (capabilities.hevcHardware) "YamibunkoHEVCHW/1" else "YamibunkoHEVCHW/0"
        val h264Token = if (capabilities.h264Hardware) "YamibunkoH264HW/1" else "YamibunkoH264HW/0"

        return "YamibunkoTV/1.0 YamibunkoTV-WebView/1.0 $av1Token $hevcToken $h264Token"
    }

    private fun appendMissingTokens(userAgent: String, appTokens: String): String {
        val tokensToAppend = appTokens
            .split(' ')
            .filter { token ->
                val tokenName = token.substringBefore('/')
                !userAgent.contains(tokenName, ignoreCase = true)
            }

        return if (tokensToAppend.isEmpty()) {
            userAgent
        } else {
            "$userAgent ${tokensToAppend.joinToString(" ")}"
        }
    }
}
