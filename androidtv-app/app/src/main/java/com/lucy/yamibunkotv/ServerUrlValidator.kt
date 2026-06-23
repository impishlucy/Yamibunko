package com.lucy.yamibunkotv

import android.net.Uri
import java.util.Locale

object ServerUrlValidator {
    private val explicitSchemePattern = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")

    fun normalizeBaseUrl(value: String, selectedScheme: String): UrlValidationResult {
        val rawValue = value.trim().trimEnd('/')
        if (rawValue.isBlank()) {
            return UrlValidationResult.Error(R.string.server_url_error_required)
        }

        if (rawValue.any { it.isWhitespace() }) {
            return UrlValidationResult.Error(R.string.server_url_error_invalid)
        }

        val urlValue = if (explicitSchemePattern.containsMatchIn(rawValue)) {
            rawValue
        } else {
            "${selectedScheme}://$rawValue"
        }
        val uri = Uri.parse(urlValue)
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        val host = uri.host?.lowercase(Locale.ROOT)

        if (scheme != "http" && scheme != "https") {
            return UrlValidationResult.Error(R.string.server_url_error_scheme)
        }

        if (host.isNullOrBlank() || uri.userInfo != null) {
            return UrlValidationResult.Error(R.string.server_url_error_invalid)
        }

        if (isLocalHost(host)) {
            return UrlValidationResult.Error(R.string.server_url_error_localhost)
        }

        if (scheme == "http" && !isPrivateIpv4(host)) {
            return UrlValidationResult.Error(R.string.server_url_error_http_lan)
        }

        return UrlValidationResult.Success(urlValue)
    }

    private fun isLocalHost(host: String): Boolean {
        return host == "localhost" ||
            host == "0.0.0.0" ||
            host == "::1" ||
            host.startsWith("127.")
    }

    private fun isPrivateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) {
            return false
        }

        val octets = parts.map { part ->
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
        }

        return octets[0] == 10 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 169 && octets[1] == 254)
    }
}

sealed class UrlValidationResult {
    data class Success(val url: String) : UrlValidationResult()
    data class Error(val messageResId: Int) : UrlValidationResult()
}
