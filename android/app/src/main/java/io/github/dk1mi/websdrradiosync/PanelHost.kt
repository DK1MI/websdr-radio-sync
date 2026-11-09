package io.github.dk1mi.websdrradiosync

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONException
import org.json.JSONObject

/** Answer to one call from the panel's JS shim (android-shim.js). */
interface Reply {
    fun ok(json: String)
    fun fail(name: String, message: String)
}

/**
 * Exposed to the panel WebView as `AndroidHost`. Every call is asynchronous: the JS side passes
 * an id and gets the result back through `__androidShim.reply(id, ok, value)`.
 */
class PanelHost(private val activity: MainActivity, private val panel: WebView) {
    private val main = Handler(Looper.getMainLooper())
    val serial = UsbSerialBridge(activity, this)
    private val http = HttpProxy()

    @JavascriptInterface
    fun call(method: String, id: Int, argsJson: String) {
        val args = try { JSONObject(argsJson) } catch (_: JSONException) { JSONObject() }
        val reply = JsReply(id)
        try {
            when (method) {
                "sdrCommand" -> main.post {
                    if (activity.sendToSdr(args)) reply.ok("null") else reply.fail("Error", "no SDR page loaded")
                }
                "fetch" -> http.fetch(args, reply)
                "serialRequestPort" -> main.post { serial.requestPort(reply) }
                "serialGetPorts" -> serial.getPorts(reply)
                "serialOpen" -> serial.open(args, reply)
                "serialWrite" -> serial.write(args, reply)
                "serialSetSignals" -> serial.setSignals(args, reply)
                "serialGetSignals" -> serial.getSignals(args, reply)
                "serialClose" -> serial.close(args, reply)
                else -> reply.fail("Error", "unknown call $method")
            }
        } catch (e: Exception) {
            reply.fail("Error", e.message ?: e.toString())
        }
    }

    /** Sends an event to the panel: `__androidShim.event(name, data)`. Any thread. */
    fun event(name: String, json: String) = eval("__androidShim.event(${JSONObject.quote(name)},$json)")

    private fun eval(js: String) = main.post {
        if (!activity.isDestroyed) panel.evaluateJavascript("window.__androidShim&&$js", null)
    }

    private inner class JsReply(private val id: Int) : Reply {
        override fun ok(json: String) = send(true, json)
        override fun fail(name: String, message: String) =
            send(false, JSONObject().put("name", name).put("message", message).toString())
        private fun send(ok: Boolean, json: String) { eval("__androidShim.reply($id,$ok,$json)") }
    }

    fun shutdown() {
        serial.shutdown()
        http.shutdown()
    }
}
