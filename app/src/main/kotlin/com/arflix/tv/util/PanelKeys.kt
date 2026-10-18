package com.arflix.tv.util

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * API keys set in the panel (Panel > API keys). They replace the keys built into the app for
 * every line; a key the panel leaves empty falls back to the built-in one.
 *
 * Kept in SharedPreferences so [Constants] can read them synchronously from any thread,
 * including during start-up before the first network call.
 */
object PanelKeys {
    private const val PREFS = "panel_keys"
    private const val KEY_VALUES = "values"
    private const val KEY_EXTRA = "extra"
    private const val KEY_REVISION = "revision"

    @Volatile private var prefs: SharedPreferences? = null
    @Volatile private var cache: Map<String, String> = emptyMap()

    /** Call once from Application.attachBaseContext, before any repository is created. */
    fun init(context: Context) {
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        cache = parse(p.getString(KEY_VALUES, null))
    }

    /** The panel's value for [name], or null when the panel did not set one. */
    fun get(name: String): String? = cache[name]?.takeIf { it.isNotBlank() }

    /** Extra keys the panel admin added for future features. */
    fun extra(name: String): String? =
        parse(prefs?.getString(KEY_EXTRA, null))[name]?.takeIf { it.isNotBlank() }

    val revision: String get() = prefs?.getString(KEY_REVISION, null).orEmpty()

    /** Stores the panel's `config.php` answer: `{"revision", "keys": {...}, "extra": {...}}`. */
    fun apply(configJson: String) {
        val root = JSONObject(configJson)
        val keys = root.optJSONObject("keys") ?: JSONObject()
        val extra = root.optJSONObject("extra") ?: JSONObject()
        prefs?.edit()
            ?.putString(KEY_VALUES, keys.toString())
            ?.putString(KEY_EXTRA, extra.toString())
            ?.putString(KEY_REVISION, root.optString("revision"))
            ?.apply()
        cache = parse(keys.toString())
    }

    fun clear() {
        prefs?.edit()?.clear()?.apply()
        cache = emptyMap()
    }

    private fun parse(json: String?): Map<String, String> = runCatching {
        val o = JSONObject(json ?: return emptyMap())
        o.keys().asSequence().associateWith { o.optString(it) }.filterValues { it.isNotBlank() }
    }.getOrDefault(emptyMap())
}
