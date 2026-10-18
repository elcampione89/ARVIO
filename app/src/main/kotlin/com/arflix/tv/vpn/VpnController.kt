package com.arflix.tv.vpn

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.VpnService
import android.os.Build
import com.arflix.tv.util.AppLogger
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.StringReader
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * One-press VPN built into the app (Panel > VPN). WireGuard runs inside ARVIO through the
 * WireGuard tunnel library, so nothing else needs installing. The panel creates this device's
 * WireGuard client on the admin's wg-easy server and hands the config over; users never see it.
 *
 * The only prompt is Android's own one-time "allow VPN connection" screen; after the user
 * answers it the connection continues by itself (see [onAppResumed]).
 */
object VpnController {

    enum class Phase { OFF, NEEDS_SETUP, WORKING, CONNECTING, CONNECTED, FAILED }

    data class Server(val id: Int, val label: String, val country: String, val host: String, val port: Int)

    data class State(
        /** The panel switched the VPN on and has at least one server. */
        val offered: Boolean = false,
        val servers: List<Server> = emptyList(),
        /** "auto" for the fastest server, otherwise a server id. */
        val selected: String = AUTO,
        val phase: Phase = Phase.OFF,
        /** The server in use or being connected to. */
        val serverLabel: String? = null,
        /** What the user needs to know, if anything. */
        val message: String? = null
    ) {
        val isOn: Boolean get() = phase == Phase.CONNECTED || phase == Phase.CONNECTING
        val selectedLabel: String get() =
            if (selected == AUTO) "Fastest" else servers.firstOrNull { it.id.toString() == selected }?.label ?: "Fastest"
    }

    const val AUTO = "auto"
    private const val PREFS = "panel_vpn"
    private const val FILE = "panel_vpn.json"
    private const val CONFIG_DIR = "panel_wg"

    /**
     * Fetches this device's WireGuard config for a server from the panel. Set by AuthRepository,
     * which holds the sign-in; throws with a message the user can read when the panel refuses.
     */
    @Volatile var configProvider: (suspend (serverId: Int) -> String)? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    @Volatile private var appContext: Context? = null
    @Volatile private var prefs: SharedPreferences? = null
    @Volatile private var arvioOnly: Boolean = true
    @Volatile private var pendingConnect = false
    @Volatile private var backend: GoBackend? = null

    private val tunnel = object : Tunnel {
        override fun getName(): String = "arvio"

        override fun onStateChange(newState: Tunnel.State) {
            if (newState == Tunnel.State.DOWN) {
                _state.update { if (it.phase == Phase.CONNECTED) it.copy(phase = Phase.OFF, message = null) else it }
            }
        }
    }

    /** Call once at start-up. Loads the last servers the panel sent. */
    fun init(context: Context) {
        val app = context.applicationContext ?: context
        appContext = app
        val p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        val cached = runCatching { File(app.filesDir, FILE).takeIf { it.isFile }?.readText() }.getOrNull()
        if (cached != null) runCatching { load(cached) }
        _state.update { it.copy(selected = p.getString("selected", AUTO) ?: AUTO) }
    }

    val revision: String get() = prefs?.getString("revision", null).orEmpty()

    /** Stores the panel's vpn.php answer. */
    fun applyPanel(json: String) {
        val ctx = appContext ?: return
        load(json)
        File(ctx.filesDir, FILE).writeText(json)
        prefs?.edit()?.putString("revision", JSONObject(json).optString("revision"))?.apply()
        // Forget cached configs of servers the panel no longer offers.
        val keep = _state.value.servers.map { "${it.id}.conf" }.toSet()
        File(ctx.filesDir, CONFIG_DIR).listFiles()?.filter { it.name !in keep }?.forEach { it.delete() }
    }

    private fun load(json: String) {
        val root = JSONObject(json)
        val list = root.optJSONArray("servers") ?: JSONArray()
        val servers = (0 until list.length()).mapNotNull { i ->
            val o = list.optJSONObject(i) ?: return@mapNotNull null
            Server(
                id = o.optInt("id"),
                label = o.optString("label").ifBlank { "VPN" },
                country = o.optString("country"),
                host = o.optString("host"),
                port = o.optInt("port", 443)
            ).takeIf { it.id > 0 }
        }
        arvioOnly = root.optBoolean("arvio_only", true)
        _state.update { s ->
            val selected = if (s.selected == AUTO || servers.any { it.id.toString() == s.selected }) s.selected else AUTO
            s.copy(offered = root.optBoolean("enabled") && servers.isNotEmpty(), servers = servers, selected = selected)
        }
    }

    /** Signed out: drop the connection and forget the servers and this device's configs. */
    fun clear() {
        runCatching { backend?.setState(tunnel, Tunnel.State.DOWN, null) }
        appContext?.let { ctx ->
            runCatching { File(ctx.filesDir, FILE).delete() }
            runCatching { File(ctx.filesDir, CONFIG_DIR).deleteRecursively() }
        }
        prefs?.edit()?.remove("revision")?.apply()
        pendingConnect = false
        _state.value = State(selected = _state.value.selected)
    }

    /** Moves the location choice to the next option: Fastest, then each server in panel order. */
    fun cycleLocation() {
        val s = _state.value
        val options = listOf(AUTO) + s.servers.map { it.id.toString() }
        val next = options[(options.indexOf(s.selected).coerceAtLeast(0) + 1) % options.size]
        prefs?.edit()?.putString("selected", next)?.apply()
        _state.update { it.copy(selected = next) }
    }

    /** The VPN switch: connects when off, disconnects when on. */
    fun toggle(context: Context) {
        val s = _state.value
        if (s.phase == Phase.WORKING) return
        scope.launch {
            try {
                if (s.isOn) disconnect() else connect(context)
            } catch (e: Exception) {
                AppLogger.breadcrumb("Vpn", "toggle_failed ${e.javaClass.simpleName}", severity = "warning")
                _state.update { it.copy(phase = Phase.FAILED, message = friendlyError(e)) }
            }
        }
    }

    /** Called when ARVIO comes back to the front: carries on after Android's VPN permission screen. */
    fun onAppResumed(context: Context) {
        if (!pendingConnect) return
        pendingConnect = false
        if (runCatching { VpnService.prepare(context) }.getOrNull() == null) {
            toggle(context)
        } else {
            _state.update { it.copy(phase = Phase.FAILED, message = "The VPN needs your permission. Press VPN and choose OK.") }
        }
    }

    private suspend fun connect(context: Context) {
        val app = context.applicationContext ?: context
        val servers = _state.value.servers
        if (servers.isEmpty()) {
            _state.update { it.copy(phase = Phase.FAILED, message = "No VPN servers are set up yet.") }
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            _state.update { it.copy(phase = Phase.FAILED, message = "The VPN needs Android 7 or newer.") }
            return
        }
        // Android's one-time "allow VPN connection" screen; we continue when the app resumes.
        VpnService.prepare(app)?.let { intent ->
            pendingConnect = true
            _state.update { it.copy(phase = Phase.NEEDS_SETUP, message = "Choose OK to allow the VPN.") }
            runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                .onFailure { pendingConnect = false; throw it }
            return
        }
        _state.update { it.copy(phase = Phase.WORKING, message = "Finding the best server…") }
        val selected = _state.value.selected
        val server = servers.firstOrNull { it.id.toString() == selected } ?: fastest(servers)
        _state.update { it.copy(phase = Phase.CONNECTING, serverLabel = server.label, message = "Connecting to ${server.label}…") }

        val goBackend = backend ?: GoBackend(app).also { backend = it }
        val cacheFile = File(File(app.filesDir, CONFIG_DIR).apply { mkdirs() }, "${server.id}.conf")
        val cached = cacheFile.takeIf { it.isFile }?.readText()
        try {
            goBackend.setState(tunnel, Tunnel.State.UP, buildConfig(cached ?: fetchConfig(server, cacheFile), app))
        } catch (e: Exception) {
            if (cached == null) throw e
            // The saved config may be stale (e.g. the panel recreated this device's client): get it again.
            cacheFile.delete()
            goBackend.setState(tunnel, Tunnel.State.UP, buildConfig(fetchConfig(server, cacheFile), app))
        }
        _state.update { it.copy(phase = Phase.CONNECTED, message = null) }
        AppLogger.breadcrumb("Vpn", "up server=${server.id}")
    }

    private suspend fun fetchConfig(server: Server, cacheFile: File): String {
        val provider = configProvider ?: error("Sign in again to use the VPN.")
        return provider(server.id).also { cacheFile.writeText(it) }
    }

    /** Parses the config; when the panel asks for it, only ARVIO's own traffic uses the tunnel. */
    private fun buildConfig(text: String, context: Context): Config {
        val hasAppRules = Regex("(?im)^\\s*(Included|Excluded)Applications\\s*=").containsMatchIn(text)
        val withApps = if (arvioOnly && !hasAppRules) {
            text.replaceFirst(Regex("(?im)^\\s*\\[Interface]\\s*$"), "[Interface]\nIncludedApplications = ${context.packageName}")
        } else {
            text
        }
        return Config.parse(BufferedReader(StringReader(withApps)))
    }

    private fun disconnect() {
        backend?.setState(tunnel, Tunnel.State.DOWN, null)
        _state.update { it.copy(phase = Phase.OFF, message = null) }
    }

    /** Picks the server that answers fastest (time for a TCP connection to its wg-easy address). */
    private suspend fun fastest(servers: List<Server>): Server {
        if (servers.size == 1) return servers.first()
        val timed = coroutineScope {
            servers.map { server -> async(Dispatchers.IO) { server to roundTripMs(server) } }.awaitAll()
        }
        return timed.minByOrNull { it.second }?.takeIf { it.second < Long.MAX_VALUE }?.first ?: servers.first()
    }

    private fun roundTripMs(server: Server): Long {
        if (server.host.isBlank()) return Long.MAX_VALUE
        val start = System.nanoTime()
        return try {
            Socket().use { it.connect(InetSocketAddress(server.host, server.port), 1500) }
            (System.nanoTime() - start) / 1_000_000
        } catch (_: ConnectException) {
            // Refused still means the server answered.
            (System.nanoTime() - start) / 1_000_000
        } catch (_: Exception) {
            Long.MAX_VALUE
        }
    }

    private fun friendlyError(e: Exception): String {
        val text = e.message.orEmpty()
        if (e is com.wireguard.android.backend.BackendException) {
            return when (e.reason) {
                com.wireguard.android.backend.BackendException.Reason.VPN_NOT_AUTHORIZED ->
                    "The VPN needs your permission. Press VPN and choose OK."
                com.wireguard.android.backend.BackendException.Reason.DNS_RESOLUTION_FAILURE ->
                    "Couldn't find the VPN server. Check the internet connection and try again."
                else -> "The VPN couldn't start (${e.reason.name.lowercase().replace('_', ' ')}). Please try again."
            }
        }
        if (e is com.wireguard.config.BadConfigException) {
            return "The VPN server sent a config the app can't read. Please contact your provider."
        }
        return when {
            e is java.io.IOException -> "Couldn't reach the VPN. Check the internet connection and try again."
            text.contains("VPN_NOT_AUTHORIZED", ignoreCase = true) -> "The VPN needs your permission. Press VPN and choose OK."
            text.isNotBlank() && !text.contains("Exception") -> text
            else -> "The VPN couldn't start. Please try again or pick another location."
        }
    }
}
