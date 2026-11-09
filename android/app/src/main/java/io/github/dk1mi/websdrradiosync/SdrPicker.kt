package io.github.dk1mi.websdrradiosync

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast

/**
 * The "SDRs" dialog: favourites, recently used SDRs, and the public directories (opened in the
 * SDR view, so the user browses them like the website itself). Long-press removes an entry.
 */
class SdrPicker(
    private val activity: Activity,
    private val store: SdrStore,
    private val directories: List<Pair<String, String>>,
    private val settings: List<Setting>,
    private val open: (String) -> Unit,
) {
    /** A row under "Settings": tapping it calls [toggle], the dialog stays open and redraws. */
    class Setting(val title: () -> String, val sub: String, val toggle: () -> Unit)

    private sealed class Row {
        class Header(val text: String) : Row()
        class Item(
            val title: String,
            val sub: String,
            val click: () -> Unit,
            val remove: (() -> String)? = null,
            val keepOpen: Boolean = false,
        ) : Row()
    }

    private lateinit var dialog: AlertDialog
    private val adapter = Adapter()

    fun show() {
        adapter.rows = rows()
        val list = ListView(activity).apply {
            adapter = this@SdrPicker.adapter
            setOnItemClickListener { _, _, pos, _ ->
                val r = this@SdrPicker.adapter.rows[pos]
                if (r !is Row.Item) return@setOnItemClickListener
                if (!r.keepOpen) dialog.dismiss()
                r.click()
                if (r.keepOpen) refresh()
            }
            setOnItemLongClickListener { _, _, pos, _ ->
                val r = this@SdrPicker.adapter.rows[pos]
                val msg = (r as? Row.Item)?.remove?.invoke() ?: return@setOnItemLongClickListener false
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
                refresh()
                true
            }
        }
        dialog = AlertDialog.Builder(activity)
            .setTitle("SDRs")
            .setView(list)
            .setNegativeButton("Close", null)
            .create()
        dialog.show()
    }

    private fun refresh() {
        adapter.rows = rows()
        adapter.notifyDataSetChanged()
    }

    private fun rows(): List<Row> {
        val out = mutableListOf<Row>()
        val favs = store.favourites()
        if (favs.isNotEmpty()) {
            out += Row.Header("Favourites")
            favs.forEach { e -> out += item(e) { store.removeFavourite(e.url); "Removed from favourites" } }
        }
        val recent = store.recent().filter { r -> favs.none { it.url == r.url } }
        if (recent.isNotEmpty()) {
            out += Row.Header("Recent")
            recent.forEach { e -> out += item(e) { store.removeRecent(e.url); "Removed from recent" } }
        }
        out += Row.Header("Find an SDR")
        directories.forEach { (name, url) -> out += Row.Item(name, Uri.parse(url).host ?: url, { open(url) }) }
        out += Row.Header("Settings")
        settings.forEach { s -> out += Row.Item(s.title(), s.sub, s.toggle, keepOpen = true) }
        return out
    }

    private fun item(e: SdrEntry, remove: () -> String) = Row.Item(
        title = e.title.ifBlank { e.host },
        sub = listOf(e.type, e.host).filter { it.isNotBlank() }.joinToString(" · "),
        click = { open(e.url) },
        remove = remove,
    )

    private inner class Adapter : BaseAdapter() {
        var rows: List<Row> = emptyList()
        private val dp = activity.resources.displayMetrics.density

        override fun getCount() = rows.size
        override fun getItem(pos: Int) = rows[pos]
        override fun getItemId(pos: Int) = pos.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(pos: Int) = if (rows[pos] is Row.Header) 0 else 1
        override fun isEnabled(pos: Int) = rows[pos] is Row.Item
        override fun areAllItemsEnabled() = false

        override fun getView(pos: Int, convertView: View?, parent: ViewGroup): View {
            val pad = (20 * dp).toInt()
            return when (val r = rows[pos]) {
                is Row.Header -> ((convertView as? TextView) ?: TextView(activity).apply {
                    setPadding(pad, (14 * dp).toInt(), pad, (4 * dp).toInt())
                    textSize = 12f
                    typeface = Typeface.DEFAULT_BOLD
                    isAllCaps = true
                    alpha = 0.7f
                }).apply { text = r.text }
                is Row.Item -> {
                    val box = (convertView as? LinearLayout) ?: LinearLayout(activity).apply {
                        orientation = LinearLayout.VERTICAL
                        setPadding(pad, (8 * dp).toInt(), pad, (8 * dp).toInt())
                        addView(TextView(activity).apply { textSize = 16f; maxLines = 2 })
                        addView(TextView(activity).apply { textSize = 12f; alpha = 0.7f; maxLines = 1 })
                    }
                    (box.getChildAt(0) as TextView).text = r.title
                    (box.getChildAt(1) as TextView).text = r.sub
                    box
                }
            }
        }
    }
}
