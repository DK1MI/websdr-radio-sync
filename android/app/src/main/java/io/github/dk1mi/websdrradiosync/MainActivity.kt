package io.github.dk1mi.websdrradiosync

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * Web SDR in one WebView, the extension's sync panel (panel.html, unchanged) in another.
 * Landscape: panel on the right. Portrait: panel below.
 */
class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var content: LinearLayout
    private lateinit var sdrView: WebView
    private lateinit var panelView: WebView
    private lateinit var urlField: EditText
    private lateinit var host: PanelHost
    private val prefs by lazy { getSharedPreferences("app", MODE_PRIVATE) }
    private var panelVisible = true
    private var sdrLoaded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        buildUi()
        host = PanelHost(this, panelView)
        setupPanel()
        setupSdr()
        loadSdr(prefs.getString(KEY_LAST, null) ?: DEFAULT_SDR)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) usbDevice(intent)?.let { host.serial.onAttached(it) }
    }

    /* ------------------------------------------------------------ layout */

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF202124.toInt())
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(6), 0, dp(6), 0)
        }
        urlField = EditText(this).apply {
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            hint = "SDR address"
            textSize = 14f
            setTextColor(0xFFE8EAED.toInt())
            setHintTextColor(0xFF9AA0A6.toInt())
            setSelectAllOnFocus(true)
            setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_GO) { loadSdr(text.toString()); true } else false
            }
        }
        val recentBtn = Button(this).apply { text = "Recent"; setOnClickListener { showRecent() } }
        val panelBtn = Button(this).apply {
            text = "Panel"
            setOnClickListener {
                panelVisible = !panelVisible
                panelView.visibility = if (panelVisible) View.VISIBLE else View.GONE
            }
        }
        bar.addView(urlField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(recentBtn)
        bar.addView(panelBtn)

        sdrView = WebView(this)
        panelView = WebView(this)
        content = LinearLayout(this)
        content.addView(sdrView)
        content.addView(panelView)
        root.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(content, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        applyLayout(resources.configuration)

        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            root.setOnApplyWindowInsetsListener { v, insets ->
                val i = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout()
                )
                v.setPadding(i.left, i.top, i.right, i.bottom)
                WindowInsets.CONSUMED
            }
        }
    }

    private fun applyLayout(cfg: Configuration) {
        val landscape = cfg.orientation == Configuration.ORIENTATION_LANDSCAPE
        val match = LinearLayout.LayoutParams.MATCH_PARENT
        content.orientation = if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        sdrView.layoutParams = if (landscape) LinearLayout.LayoutParams(0, match, 1f) else LinearLayout.LayoutParams(match, 0, 1f)
        panelView.layoutParams = if (landscape) LinearLayout.LayoutParams(dp(380), match) else LinearLayout.LayoutParams(match, 0, 0.8f)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyLayout(newConfig)
    }

    /* ------------------------------------------------------------ panel WebView */

    private fun setupPanel() {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        panelView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        panelView.addJavascriptInterface(host, "AndroidHost")
        panelView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host == PANEL_HOST && request.url.path == PANEL_PATH) return patchedPanel()
                return loader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == PANEL_HOST) return false
                openExternal(request.url) // links in the panel (spot pages, README) go to the browser
                return true
            }
        }
        panelView.loadUrl("https://$PANEL_HOST$PANEL_PATH")
    }

    // panel.html with the shim as the first script, so chrome.* exists before panel.js runs.
    private fun patchedPanel(): WebResourceResponse {
        val html = assets.open("ext/panel.html").bufferedReader().readText()
            .replaceFirst("<head>", "<head>\n  <script src=\"/assets/android-shim.js\"></script>")
        return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
    }

    /* ------------------------------------------------------------ SDR WebView */

    private fun setupSdr() {
        sdrView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        sdrView.addJavascriptInterface(SdrBridge(), "SdrBridge")
        // The extension's content script, unchanged, plus the Android relay. Top frame only,
        // like the extension's content scripts.
        val script = "if (window === window.top) {\n" +
            assets.open("ext/content/sdr-main.js").bufferedReader().readText() + "\n" +
            assets.open("sdr-bridge.js").bufferedReader().readText() + "\n}"
        val docStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (docStart) WebViewCompat.addDocumentStartJavaScript(sdrView, script, setOf("*"))

        sdrView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                sdrLoaded = true
                host.event("sdrGone", "{}") // like closing the SDR tab: the panel waits for the new page
                if (!urlField.hasFocus()) urlField.setText(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!docStart) view.evaluateJavascript(script, null)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme
                if (scheme == "http" || scheme == "https") return false
                openExternal(request.url)
                return true
            }
        }
        sdrView.webChromeClient = WebChromeClient()
    }

    /** Reports from sdr-main.js on the SDR page; checked again by the shim. */
    private inner class SdrBridge {
        @JavascriptInterface
        fun post(json: String) {
            if (json.length > 4000) return
            val o = try { JSONObject(json) } catch (_: JSONException) { return }
            host.event("sdrState", o.toString())
        }
    }

    /** A command from the panel to the SDR page (what chrome.tabs.sendMessage does in the extension). */
    fun sendToSdr(c: JSONObject): Boolean {
        if (!sdrLoaded) return false
        val cmd = JSONObject()
        if (c.optBoolean("get")) cmd.put("get", true)
        val hz = c.optDouble("hz", Double.NaN)
        if (hz.isFinite()) cmd.put("hz", hz)
        val mode = c.opt("mode")
        if (mode is String) cmd.put("mode", mode.take(8))
        sdrView.evaluateJavascript("window.postMessage({tag:'__sdr_radio_sync__',dir:'to-page',cmd:$cmd},'*')", null)
        return true
    }

    private fun loadSdr(raw: String) {
        var url = raw.trim()
        if (url.isEmpty()) return
        if (!url.contains("://")) url = "http://$url"
        val uri = Uri.parse(url)
        if ((uri.scheme != "http" && uri.scheme != "https") || uri.host.isNullOrEmpty()) return
        urlField.setText(url)
        urlField.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(urlField.windowToken, 0)
        sdrView.loadUrl(url)
        val recent = recentList().filter { it != url }.toMutableList()
        recent.add(0, url)
        prefs.edit()
            .putString(KEY_LAST, url)
            .putString(KEY_RECENT, JSONArray(recent.take(15)).toString())
            .apply()
    }

    private fun recentList(): List<String> = try {
        val a = JSONArray(prefs.getString(KEY_RECENT, "[]"))
        List(a.length()) { a.getString(it) }
    } catch (_: JSONException) { emptyList() }

    private fun showRecent() {
        val items = (recentList() + DEFAULT_SDR).distinct().toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Recent SDRs")
            .setItems(items) { _, i -> loadSdr(items[i]) }
            .show()
    }

    private fun openExternal(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: Exception) {}
    }

    @Suppress("DEPRECATION")
    private fun usbDevice(i: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else i.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (sdrView.canGoBack()) sdrView.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onDestroy() {
        host.shutdown()
        sdrView.destroy()
        panelView.destroy()
        super.onDestroy()
    }

    companion object {
        const val PANEL_HOST = "appassets.androidplatform.net"
        const val PANEL_PATH = "/assets/ext/panel.html"
        const val DEFAULT_SDR = "http://websdr.ewi.utwente.nl:8901/"
        const val KEY_LAST = "lastSdr"
        const val KEY_RECENT = "recentSdrs"
    }
}
