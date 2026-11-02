package com.arflix.tv.util

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Avatars the panel admin uploaded (panel > Avatars). Shown as an extra set in the profile
 * avatar picker; picking one downloads it and uses it as the profile's own picture, so it syncs
 * to the user's other devices and the web app like any uploaded photo.
 */
object PanelAvatars {
    data class Item(val id: String, val name: String, val url: String)
    data class Set(val label: String = "", val items: List<Item> = emptyList())

    @Volatile
    var revision: String = ""
        private set

    private val _state = MutableStateFlow(Set())
    val state: StateFlow<Set> = _state.asStateFlow()

    private fun cacheFile(context: Context) = File(context.filesDir, "panel_avatars.json")

    /** Applies the panel's avatars.php reply. */
    fun apply(context: Context?, body: String) {
        val root = JSONObject(body)
        val list = root.optJSONArray("avatars")
        val items = buildList {
            if (list != null) for (i in 0 until list.length()) {
                val o = list.optJSONObject(i) ?: continue
                val id = o.optString("id").filter { it.isLetterOrDigit() }
                val url = o.optString("url")
                if (id.isBlank() || !(url.startsWith("https://") || url.startsWith("http://"))) continue
                add(Item(id, o.optString("name"), url))
            }
        }
        revision = root.optString("revision")
        _state.value = Set(root.optString("label"), items)
        if (context != null) runCatching { cacheFile(context).writeText(body) }
    }

    /** Shows the last known set straight away on app start, before the panel is asked again. */
    fun restore(context: Context) {
        if (revision.isNotBlank()) return
        val file = cacheFile(context)
        if (file.isFile) runCatching { apply(null, file.readText()) }
    }

    fun clear(context: Context?) {
        revision = ""
        _state.value = Set()
        if (context != null) runCatching { cacheFile(context).delete() }
    }

    /** Downloads one avatar into the cache and returns a file:// URI for the profile editor. */
    suspend fun download(context: Context, item: Item): String = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "panel_avatar_pick").apply { mkdirs() }
        val file = File(dir, "${item.id}.jpg")
        if (!file.isFile || file.length() == 0L) {
            val conn = (URL(item.url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 20_000
                instanceFollowRedirects = true
            }
            try {
                if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
                val tmp = File(dir, "${item.id}.part")
                conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                if (!tmp.renameTo(file)) {
                    tmp.copyTo(file, overwrite = true)
                    tmp.delete()
                }
            } finally {
                conn.disconnect()
            }
        }
        android.net.Uri.fromFile(file).toString()
    }
}
