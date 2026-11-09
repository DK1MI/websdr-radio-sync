package io.github.dk1mi.websdrradiosync

import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** One SDR the user opened. [type] is what sdr-main.js detected: WebSDR, KiwiSDR, OpenWebRX(+). */
data class SdrEntry(val url: String, val title: String, val type: String) {
    val host: String get() = Uri.parse(url).host ?: url

    fun toJson(): JSONObject = JSONObject().put("url", url).put("title", title).put("type", type)

    companion object {
        fun fromJson(v: Any?): SdrEntry? = when (v) {
            is JSONObject -> v.optString("url").takeIf { it.isNotEmpty() }
                ?.let { SdrEntry(it, v.optString("title"), v.optString("type")) }
            is String -> SdrEntry(v, "", "") // the prototype stored plain URLs
            else -> null
        }
    }
}

/** Recent and favourite SDRs, kept in SharedPreferences. Only pages recognised as SDRs get in. */
class SdrStore(private val prefs: SharedPreferences) {
    val last: String? get() = prefs.getString(KEY_LAST, null)

    /** Open PA3FWM WebSDRs on their mobile page (m.html). On by default. */
    var websdrMobile: Boolean
        get() = prefs.getBoolean(KEY_WEBSDR_MOBILE, true)
        set(v) { prefs.edit().putBoolean(KEY_WEBSDR_MOBILE, v).apply() }

    /** Keep the screen on while the app is open. Off by default: SyncService keeps it running anyway. */
    var keepScreenOn: Boolean
        get() = prefs.getBoolean(KEY_KEEP_SCREEN_ON, false)
        set(v) { prefs.edit().putBoolean(KEY_KEEP_SCREEN_ON, v).apply() }

    /** The detected SDR type of a remembered address, or null if unknown. */
    fun typeOf(url: String): String? =
        (favourites() + recent()).firstOrNull { it.url == url }?.type?.takeIf { it.isNotEmpty() }

    fun recent() = load(KEY_RECENT)
    fun favourites() = load(KEY_FAVOURITES)
    fun isFavourite(url: String) = favourites().any { it.url == url }

    fun addRecent(e: SdrEntry) {
        save(KEY_RECENT, (listOf(e) + recent().filter { it.url != e.url }).take(MAX_RECENT))
        prefs.edit().putString(KEY_LAST, e.url).apply()
        // Keep a favourite's title current (SDR owners rename their receivers).
        val favs = favourites()
        if (favs.any { it.url == e.url && (it.title != e.title || it.type != e.type) }) {
            save(KEY_FAVOURITES, favs.map { if (it.url == e.url) e else it })
        }
    }

    fun removeRecent(url: String) = save(KEY_RECENT, recent().filter { it.url != url })

    fun addFavourite(e: SdrEntry) {
        if (!isFavourite(e.url)) save(KEY_FAVOURITES, favourites() + e)
    }

    fun removeFavourite(url: String) = save(KEY_FAVOURITES, favourites().filter { it.url != url })

    private fun load(key: String): List<SdrEntry> = try {
        val a = JSONArray(prefs.getString(key, "[]"))
        (0 until a.length()).mapNotNull { SdrEntry.fromJson(a.get(it)) }
    } catch (_: JSONException) { emptyList() }

    private fun save(key: String, list: List<SdrEntry>) {
        prefs.edit().putString(key, JSONArray(list.map { it.toJson() }).toString()).apply()
    }

    companion object {
        private const val KEY_LAST = "lastSdr"
        private const val KEY_RECENT = "recentSdrs"
        private const val KEY_FAVOURITES = "favouriteSdrs"
        private const val KEY_WEBSDR_MOBILE = "websdrMobile"
        private const val KEY_KEEP_SCREEN_ON = "keepScreenOn"
        private const val MAX_RECENT = 20

        /** The SDR's address without query and fragment (WebSDR/KiwiSDR put the tuning there). */
        fun normalize(url: String): String =
            Uri.parse(url).buildUpon().clearQuery().fragment(null).build().toString()
    }
}
