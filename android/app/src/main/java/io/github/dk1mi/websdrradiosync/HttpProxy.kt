package io.github.dk1mi.websdrradiosync

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * fetch() for the panel without CORS, like the extension gets through its host permissions:
 * the logbook (Wavelog/Cloudlog) API sends no CORS headers.
 */
class HttpProxy {
    private val pool = Executors.newCachedThreadPool()

    fun fetch(args: JSONObject, reply: Reply) = pool.execute {
        var c: HttpURLConnection? = null
        try {
            val url = URL(args.getString("url"))
            if (url.protocol != "http" && url.protocol != "https") throw IOException("unsupported scheme")
            c = url.openConnection() as HttpURLConnection
            c.requestMethod = args.optString("method", "GET").uppercase()
            c.connectTimeout = 15_000
            c.readTimeout = 20_000
            c.useCaches = false
            c.instanceFollowRedirects = true
            args.optJSONObject("headers")?.let { h ->
                for (k in h.keys()) c.setRequestProperty(k, h.getString(k))
            }
            if (!args.isNull("body")) {
                val body = args.getString("body").toByteArray(Charsets.UTF_8)
                c.doOutput = true
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { readLimited(it) } ?: ""
            val headers = JSONObject()
            for ((k, v) in c.headerFields) if (k != null) headers.put(k.lowercase(), v.joinToString(", "))
            reply.ok(
                JSONObject()
                    .put("status", status)
                    .put("statusText", c.responseMessage ?: "")
                    .put("headers", headers)
                    .put("body", text)
                    .toString()
            )
        } catch (e: Exception) {
            reply.fail("TypeError", "Failed to fetch")
        } finally {
            c?.disconnect()
        }
    }

    private fun readLimited(input: InputStream, max: Int = 8 shl 20): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > max) throw IOException("response too large")
        }
        return out.toString("UTF-8")
    }

    fun shutdown() = pool.shutdownNow()
}
