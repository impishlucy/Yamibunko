package com.lucy.yamibunkotv

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Rect
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "YAMIBUNKO_TV_PREFS"
        private const val SAVED_URL_KEY = "SAVED_URL"
    }

    private lateinit var webView: WebView
    private lateinit var rootLayout: ConstraintLayout
    private lateinit var setupContainer: View
    private lateinit var setupScroll: ScrollView
    private lateinit var urlSchemeSpinner: Spinner
    private lateinit var urlInput: EditText
    private lateinit var urlError: TextView
    private lateinit var saveUrlButton: Button

    private lateinit var sharedPreferences: SharedPreferences
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var webViewConfigured = false
    private var playbackActive = false
    private val videoCodecCapabilities by lazy { VideoCodecSupport.detectDeviceCapabilities() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        sharedPreferences = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        rootLayout = findViewById(R.id.constraint_layout_root)
        webView = findViewById(R.id.webView)
        setupContainer = findViewById(R.id.setup_container)
        setupScroll = findViewById(R.id.setup_scroll)
        urlSchemeSpinner = findViewById(R.id.server_url_scheme_spinner)
        urlInput = findViewById(R.id.server_url_input)
        urlError = findViewById(R.id.server_url_error)
        saveUrlButton = findViewById(R.id.save_url_button)

        setupServerUrlForm()
        setupOnBackPressed()

        val savedUrl = loadSavedUrl()
        if (savedUrl == null) {
            showSetupScreen()
        } else {
            showWebView(savedUrl)
        }

        enterImmersiveMode()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)

        if (hasFocus) {
            enterImmersiveMode()
        }
    }

    override fun onResume() {
        super.onResume()
        applyPlaybackScreenWakeLock()
    }

    override fun onDestroy() {
        exitFullscreenView()
        playbackActive = false
        applyPlaybackScreenWakeLock()
        super.onDestroy()
    }

    private fun setupOnBackPressed() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fullscreenView != null -> exitFullscreenView()
                    webView.visibility == View.VISIBLE && webView.canGoBack() -> webView.goBack()
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    private fun setupServerUrlForm() {
        val adapter = ArrayAdapter.createFromResource(
            this,
            R.array.server_url_schemes,
            R.layout.tv_spinner_item,
        )
        adapter.setDropDownViewResource(R.layout.tv_spinner_dropdown_item)
        urlSchemeSpinner.adapter = adapter
        urlSchemeSpinner.setSelection(0)

        saveUrlButton.setOnClickListener {
            saveConfiguredUrl()
        }

        urlInput.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) {
                keepUrlInputVisible()
            }
        }

        urlInput.setOnEditorActionListener { _, actionId, event ->
            val isEnterKey = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_UP
            if (actionId == EditorInfo.IME_ACTION_DONE || isEnterKey) {
                saveConfiguredUrl()
                true
            } else {
                false
            }
        }
    }

    private fun saveConfiguredUrl() {
        when (val result = ServerUrlValidator.normalizeBaseUrl(urlInput.text?.toString().orEmpty(), getSelectedScheme())) {
            is UrlValidationResult.Success -> {
                sharedPreferences.edit().putString(SAVED_URL_KEY, result.url).apply()
                hideKeyboard()
                showWebView(result.url)
            }
            is UrlValidationResult.Error -> showUrlError(result.messageResId)
        }
    }

    private fun getSelectedScheme(): String {
        val selected = urlSchemeSpinner.selectedItem?.toString()?.trim().orEmpty()

        return when {
            selected.startsWith("http://", ignoreCase = true) -> "http"
            else -> "https"
        }
    }

    private fun showUrlError(messageResId: Int) {
        urlError.setText(messageResId)
        urlError.visibility = View.VISIBLE
        urlInput.requestFocus()
        keepUrlInputVisible()
    }

    private fun hideKeyboard() {
        val inputMethodManager = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        inputMethodManager?.hideSoftInputFromWindow(urlInput.windowToken, 0)
    }

    private fun keepUrlInputVisible() {
        urlInput.postDelayed({
            val inputRect = Rect(0, 0, urlInput.width, urlInput.height)
            urlInput.requestRectangleOnScreen(inputRect, true)
            setupScroll.smoothScrollTo(0, (urlInput.top - 96).coerceAtLeast(0))
        }, 220)
    }

    private fun showSetupScreen() {
        setupContainer.visibility = View.VISIBLE
        webView.visibility = View.GONE
        urlError.visibility = View.GONE
        urlSchemeSpinner.requestFocus()
    }

    private fun showWebView(url: String) {
        setupContainer.visibility = View.GONE
        webView.visibility = View.VISIBLE

        if (!webViewConfigured) {
            setupWebView()
            webViewConfigured = true
        }

        webView.loadUrl(url)
        webView.requestFocus()
        enterImmersiveMode()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.addJavascriptInterface(
            PlaybackCapabilitiesBridge(videoCodecCapabilities) { active ->
                setPlaybackActive(active)
            },
            "YamibunkoAndroidTv",
        )
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectPlaybackObserver()
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden()
                    return
                }

                fullscreenView = view
                fullscreenCallback = callback
                rootLayout.visibility = View.GONE

                val decorView = window.decorView as ViewGroup
                decorView.addView(
                    view,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    ),
                )

                enterImmersiveMode()
            }

            override fun onHideCustomView() {
                exitFullscreenView()
            }
        }

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            loadsImagesAutomatically = true
            userAgentString = YamibunkoUserAgent.build(userAgentString, videoCodecCapabilities)
        }
    }


    private fun setPlaybackActive(active: Boolean) {
        runOnUiThread {
            if (playbackActive == active) {
                return@runOnUiThread
            }

            playbackActive = active
            applyPlaybackScreenWakeLock()
        }
    }

    private fun applyPlaybackScreenWakeLock() {
        webView.keepScreenOn = playbackActive

        if (playbackActive) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun injectPlaybackObserver() {
        val script = """
            (function() {
                if (window.__yamibunkoPlaybackObserverInstalled) {
                    if (typeof window.__yamibunkoNotifyPlaybackActive === 'function') {
                        window.__yamibunkoNotifyPlaybackActive();
                    }
                    return;
                }

                window.__yamibunkoPlaybackObserverInstalled = true;

                var lastActive = null;

                function isActiveVideo(video) {
                    return video instanceof HTMLVideoElement && !video.paused && !video.ended && video.readyState > 0;
                }

                function notifyPlaybackActive() {
                    var videos = Array.prototype.slice.call(document.getElementsByTagName('video'));
                    var active = videos.some(isActiveVideo);

                    if (lastActive === active) {
                        return;
                    }

                    lastActive = active;

                    if (window.YamibunkoAndroidTv && typeof window.YamibunkoAndroidTv.setPlaybackActive === 'function') {
                        window.YamibunkoAndroidTv.setPlaybackActive(active);
                    }
                }

                window.__yamibunkoNotifyPlaybackActive = notifyPlaybackActive;

                document.addEventListener('play', notifyPlaybackActive, true);
                document.addEventListener('playing', notifyPlaybackActive, true);
                document.addEventListener('pause', notifyPlaybackActive, true);
                document.addEventListener('ended', notifyPlaybackActive, true);
                document.addEventListener('emptied', notifyPlaybackActive, true);
                document.addEventListener('abort', notifyPlaybackActive, true);
                document.addEventListener('error', notifyPlaybackActive, true);

                new MutationObserver(notifyPlaybackActive).observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                });

                window.setInterval(notifyPlaybackActive, 2000);
                notifyPlaybackActive();
            })();
        """.trimIndent()

        webView.evaluateJavascript(script, null)
    }

    private fun exitFullscreenView() {
        val view = fullscreenView ?: return
        val decorView = window.decorView as ViewGroup

        decorView.removeView(view)
        fullscreenView = null
        rootLayout.visibility = View.VISIBLE
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        webView.requestFocus()
        enterImmersiveMode()
    }

    private fun enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun loadSavedUrl(): String? {
        return sharedPreferences.getString(SAVED_URL_KEY, null)?.takeIf { it.isNotBlank() }
    }

}
