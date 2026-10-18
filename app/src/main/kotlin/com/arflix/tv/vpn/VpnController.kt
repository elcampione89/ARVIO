package com.arflix.tv.vpn

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import com.arflix.tv.network.OkHttpProvider
import com.arflix.tv.updater.ApkInstaller
import com.arflix.tv.util.AppLogger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket

/**
 * One-tap VPN for panel users (Panel > VPN). The panel sends its OpenVPN servers with their
 * logins; this connects to the fastest one (or the one the user picked) through the free
 * "OpenVPN for Android" app, installing it first if the device doesn't have it.
 *
 * Users never see a config or password: the config is handed to OpenVPN for Android inline.
 */
object VpnController {

    enum class Phase { OFF, NEEDS_SETUP, WORKING, CONNECTING, CONNECTED, FAILED }

    data class Server(
        val id: Int,
        val country: String,
        val label: String,
        val config: String,
        val username: String,
        val password: String
    )

    data class State(
        /** The panel switched the VPN on and has at least one server. */
        val offered: Boolean = false,
        val servers: List<Server> = emptyList(),
        /** "auto" for the fastest server, otherwise a server id. */
        val selected: String = AUTO,
        val phase: Phase = Phase.OFF,
        /** The server in use or being connected to. */
        val serverLabel: String? = null,
        /** What the user needs to know or do next, if anything. */
        val message: String? = null
    ) {
        val isOn: Boolean get() = phase == Phase.CONNECTED || phase == Phase.CONNECTING
        val selectedLabel: String get() =
            if (selected == AUTO) "Fastest" else servers.firstOrNull { it.id.toString() == selected }?.label ?: "Fastest"
    }

    const val AUTO = "auto"
    private const val PREFS = "panel_vpn"
    private const val FILE = "panel_vpn.json"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    @Volatile private var appContext: Context? = null
    @Volatile private var prefs: SharedPreferences? = null
    @Volatile private var openVpnApkUrl: String = ""
    @Volatile private var remote: OpenVpnRemote? = null
    @Volatile private var connection: ServiceConnection? = null
    private val statusCallback = OpenVpnRemote.StatusCallback { state, message, level -> onStatus(state, message, level) }

    /** Call once at start-up. Loads the last servers the panel sent. */
    fun init(context: Context) {
        val app = context.applicationContext ?: context
        appContext = app
        val p = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        val cached = runCatching { File(app.filesDir, FILE).takeIf { it.isFile }?.readText() }.getOrNull()
        if (cached != null) runCatching { load(cached) }
        _state.update { it.copy(selected = p.getString("selected", AUTO) ?: AUTO) }
        if (_state.value.offered && isOpenVpnInstalled(app)) {
            // Show the real status if OpenVPN for Android is already connected.
            scope.launch { runCatching { bind(app) } }
        }
    }

    val revision: String get() = prefs?.getString("revision", null).orEmpty()

    /** Stores the panel's vpn.php answer. */
    fun applyPanel(json: String) {
        val ctx = appContext ?: return
        load(json)
        File(ctx.filesDir, FILE).writeText(json)
        prefs?.edit()?.putString("revision", JSONObject(json).optString("revision"))?.apply()
    }

    private fun load(json: String) {
        val root = JSONObject(json)
        val list = root.optJSONArray("servers") ?: JSONArray()
        val servers = (0 until list.length()).mapNotNull { i ->
            val o = list.optJSONObject(i) ?: return@mapNotNull null
            val config = o.optString("config")
            if (config.isBlank()) return@mapNotNull null
            Server(
                id = o.optInt("id"),
                country = o.optString("country"),
                label = o.optString("label").ifBlank { o.optString("country") },
                config = config,
                username = o.optString("username"),
                password = o.optString("password")
            )
        }
        openVpnApkUrl = root.optString("openvpn_apk_url")
        _state.update { s ->
            val selected = if (s.selected == AUTO || servers.any { it.id.toString() == s.selected }) s.selected else AUTO
            s.copy(offered = root.optBoolean("enabled") && servers.isNotEmpty(), servers = servers, selected = selected)
        }
    }

    /** Signed out: forget the servers and drop the connection. */
    fun clear() {
        runCatching { remote?.disconnect() }
        appContext?.let { runCatching { File(it.filesDir, FILE).delete() } }
        prefs?.edit()?.remove("revision")?.apply()
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
                if (s.isOn) disconnect() else connect(context.applicationContext)
            } catch (e: Exception) {
                AppLogger.breadcrumb("Vpn", "toggle_failed ${e.javaClass.simpleName}", severity = "warning")
                _state.update { it.copy(phase = Phase.FAILED, message = friendlyError(e)) }
            }
        }
    }

    private suspend fun connect(context: Context) {
        val servers = _state.value.servers
        if (servers.isEmpty()) {
            _state.update { it.copy(phase = Phase.FAILED, message = "No VPN servers are set up yet.") }
            return
        }
        if (!isOpenVpnInstalled(context)) {
            installOpenVpn(context)
            return
        }
        _state.update { it.copy(phase = Phase.WORKING, message = "Starting…") }
        val api = bind(context) ?: run {
            _state.update { it.copy(phase = Phase.FAILED, message = "Couldn't start OpenVPN for Android. Open it once, then try again.") }
            return
        }
        // First use: OpenVPN for Android asks whether ARVIO may control it, then Android asks
        // to allow a VPN. Each is a one-time screen; the user presses VPN again afterwards.
        api.prepare(context.packageName)?.let { intent ->
            startIntent(context, intent)
            _state.update { it.copy(phase = Phase.NEEDS_SETUP, message = "Choose OK to let ARVIO use OpenVPN, then press VPN again.") }
            return
        }
        api.prepareVpnService()?.let { intent ->
            startIntent(context, intent)
            _state.update { it.copy(phase = Phase.NEEDS_SETUP, message = "Allow the VPN connection, then press VPN again.") }
            return
        }
        val selected = _state.value.selected
        val server = servers.firstOrNull { it.id.toString() == selected } ?: fastest(servers)
        _state.update { it.copy(phase = Phase.CONNECTING, serverLabel = server.label, message = "Connecting to ${server.label}…") }
        api.startVpn(inlineConfig(server))
        AppLogger.breadcrumb("Vpn", "start server=${server.id}")
    }

    private fun disconnect() {
        remote?.disconnect()
        _state.update { it.copy(phase = Phase.OFF, message = null) }
    }

    /** The config with the panel's login inlined, so OpenVPN never asks the user for it. */
    private fun inlineConfig(server: Server): String {
        val withoutAuth = server.config
            .replace(Regex("<auth-user-pass>[\\s\\S]*?</auth-user-pass>\\s*"), "")
            .lines()
            .filterNot { it.trim().startsWith("auth-user-pass") && !it.trim().startsWith("auth-user-pass-verify") }
            .joinToString("\n")
            .trimEnd()
        if (server.username.isBlank()) return withoutAuth + "\n"
        return withoutAuth + "\n<auth-user-pass>\n" + server.username + "\n" + server.password + "\n</auth-user-pass>\n"
    }

    /**
     * Picks the server that answers fastest. A TCP connection attempt to the server's port gets an
     * answer (accept or refuse) after one round trip, which works for UDP servers too.
     */
    private suspend fun fastest(servers: List<Server>): Server {
        if (servers.size == 1) return servers.first()
        val timed = kotlinx.coroutines.coroutineScope {
            servers.map { server -> async(Dispatchers.IO) { server to roundTripMs(server) } }.awaitAll()
        }
        AppLogger.breadcrumb("Vpn", "latency " + timed.joinToString { "${it.first.id}=${it.second}" })
        return timed.minByOrNull { it.second }?.takeIf { it.second < Long.MAX_VALUE }?.first ?: servers.first()
    }

    private fun roundTripMs(server: Server): Long {
        val remote = Regex("(?m)^\\s*remote\\s+(\\S+)(?:\\s+(\\d+))?").find(server.config) ?: return Long.MAX_VALUE
        val host = remote.groupValues[1]
        val port = remote.groupValues[2].toIntOrNull()
            ?: Regex("(?m)^\\s*port\\s+(\\d+)").find(server.config)?.groupValues?.get(1)?.toIntOrNull()
            ?: 1194
        val start = System.nanoTime()
        return try {
            Socket().use { it.connect(InetSocketAddress(host, port), 1500) }
            (System.nanoTime() - start) / 1_000_000
        } catch (_: ConnectException) {
            // Refused still means the server answered.
            (System.nanoTime() - start) / 1_000_000
        } catch (_: Exception) {
            Long.MAX_VALUE
        }
    }

    private fun onStatus(state: String, message: String, level: String) {
        _state.update { s ->
            when (level) {
                "LEVEL_CONNECTED" -> s.copy(phase = Phase.CONNECTED, message = null)
                "LEVEL_START", "LEVEL_CONNECTING_SERVER_REPLIED", "LEVEL_CONNECTING_NO_SERVER_REPLY_YET" ->
                    if (s.phase == Phase.OFF && state == "NOPROCESS") s else s.copy(phase = Phase.CONNECTING)
                "LEVEL_AUTH_FAILED" -> s.copy(phase = Phase.FAILED, message = "The VPN server rejected the login. Please contact your provider.")
                "LEVEL_NONETWORK" -> if (s.isOn) s.copy(phase = Phase.CONNECTING, message = "Waiting for a network connection…") else s
                "LEVEL_NOTCONNECTED", "LEVEL_VPNPAUSED" ->
                    if (s.phase == Phase.FAILED || s.phase == Phase.NEEDS_SETUP) s else s.copy(phase = Phase.OFF, message = null)
                else -> s
            }
        }
    }

    private suspend fun bind(context: Context): OpenVpnRemote? {
        remote?.let { return it }
        val ready = CompletableDeferred<OpenVpnRemote?>()
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                val api = service?.let { OpenVpnRemote(it) }
                remote = api
                // Registering fails until the user allowed ARVIO; the status then arrives after connect.
                api?.let { runCatching { it.registerStatusCallback(statusCallback) } }
                ready.complete(api)
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                remote = null
            }
        }
        val intent = Intent(OpenVpnRemote.SERVICE_ACTION).setPackage(OpenVpnRemote.PACKAGE)
        val bound = runCatching { context.bindService(intent, conn, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
        if (!bound) return null
        connection = conn
        val api = withTimeoutOrNull(8_000) { ready.await() }
        api?.let { runCatching { it.registerStatusCallback(statusCallback) } }
        return api
    }

    fun isOpenVpnInstalled(context: Context): Boolean = runCatching {
        if (Build.VERSION.SDK_INT >= 33) {
            context.packageManager.getPackageInfo(OpenVpnRemote.PACKAGE, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(OpenVpnRemote.PACKAGE, 0)
        }
        true
    }.getOrDefault(false)

    /** Downloads and installs OpenVPN for Android (the link comes from the panel). */
    private fun installOpenVpn(context: Context) {
        if (!ApkInstaller.canRequestPackageInstalls(context)) {
            ApkInstaller.buildUnknownSourcesSettingsIntent(context)?.let { startIntent(context, it) }
            _state.update {
                it.copy(phase = Phase.NEEDS_SETUP, message = "Allow ARVIO to install apps, then press VPN again to install OpenVPN for Android.")
            }
            return
        }
        val url = openVpnApkUrl.ifBlank {
            _state.update { it.copy(phase = Phase.FAILED, message = "Install the OpenVPN for Android app, then press VPN again.") }
            return
        }
        _state.update { it.copy(phase = Phase.WORKING, message = "Downloading OpenVPN for Android…") }
        val file = File(context.cacheDir, "openvpn-for-android.apk")
        OkHttpProvider.client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!response.isSuccessful) error("download failed (${response.code})")
            val body = response.body ?: error("empty download")
            file.outputStream().use { out -> body.byteStream().use { it.copyTo(out) } }
        }
        ApkInstaller.launchInstall(context, file)
        _state.update {
            it.copy(phase = Phase.NEEDS_SETUP, message = "Install OpenVPN for Android, then press VPN again.")
        }
    }

    private fun startIntent(context: Context, intent: Intent) {
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { AppLogger.breadcrumb("Vpn", "launch_failed ${it.javaClass.simpleName}", severity = "warning") }
    }

    private fun friendlyError(e: Exception): String = when (e) {
        is java.io.IOException -> "Couldn't reach the internet. Check the connection and try again."
        is SecurityException -> "OpenVPN for Android didn't allow ARVIO. Press VPN again and choose OK."
        else -> e.message?.takeIf { it.isNotBlank() }?.let { "VPN error: $it" } ?: "The VPN couldn't start. Please try again."
    }
}
