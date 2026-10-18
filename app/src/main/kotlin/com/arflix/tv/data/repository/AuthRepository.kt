package com.arflix.tv.data.repository

import android.content.Context
import android.util.Base64
import android.util.Log
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.arflix.tv.data.model.Addon
import com.arflix.tv.util.AppLogger
import com.arflix.tv.util.Constants
import com.arflix.tv.util.authDataStore
import com.arflix.tv.util.settingsDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import org.json.JSONObject
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

@Serializable
data class UserProfile(
    val id: String = "",
    val email: String = "",
    val trakt_token: kotlinx.serialization.json.JsonObject? = null,
    val addons: String? = null,
    val default_subtitle: String? = null,
    val auto_play_next: Boolean? = null,
    val created_at: String? = null,
    val updated_at: String? = null
)

sealed class AuthState {
    data object Loading : AuthState()
    data object NotAuthenticated : AuthState()
    data class Authenticated(
        val userId: String,
        val email: String,
        val profile: UserProfile?
    ) : AuthState()
    data class Error(val message: String) : AuthState()
}

@Singleton
class AuthRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val cockpitArvioApi: com.arflix.tv.data.api.CockpitArvioApi,
    private val streamRepositoryProvider: Provider<StreamRepository>,
    private val traktRepositoryProvider: Provider<TraktRepository>,
    private val catalogRepositoryProvider: Provider<CatalogRepository>,
    private val profileRepositoryProvider: Provider<ProfileRepository>
) {
    private val TAG = "AuthRepository"

    private object PrefsKeys {
        val ACCESS_TOKEN = stringPreferencesKey("access_token")
        val REFRESH_TOKEN = stringPreferencesKey("refresh_token")
        val USER_ID = stringPreferencesKey("user_id")
        val USER_EMAIL = stringPreferencesKey("user_email")
        val DISPLAY_NAME = stringPreferencesKey("display_name")
        val ACCOUNT_SYNC_PAYLOAD = stringPreferencesKey("account_sync_payload")
        val PANEL_ADDONS_REVISION = stringPreferencesKey("panel_addons_revision")
        /** "<collections revision>|<profile ids>": packs are re-applied when either changes. */
        val PANEL_COLLECTIONS_STATE = stringPreferencesKey("panel_collections_state")
    }

    private val _authState = MutableStateFlow<AuthState>(AuthState.Loading)
    val authState: StateFlow<AuthState> = _authState.asStateFlow()

    private val _userProfile = MutableStateFlow<UserProfile?>(null)
    val userProfile: StateFlow<UserProfile?> = _userProfile.asStateFlow()
    private val gson = Gson()
    private val panelScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        // The VPN asks the panel for this device's WireGuard config with the current sign-in.
        com.arflix.tv.vpn.VpnController.configProvider = { serverId ->
            val token = context.authDataStore.data.first()[PrefsKeys.ACCESS_TOKEN]
            if (token.isNullOrBlank()) throw IllegalStateException("Sign in again to use the VPN.")
            try {
                val body = cockpitArvioApi.getVpnConfig("Bearer $token", serverId).use { it.string() }
                JSONObject(body).getString("config")
            } catch (e: HttpException) {
                throw IllegalStateException(panelErrorMessage(e, "The VPN server is not available right now."))
            }
        }
    }

    /** Stable per-install id so signing in again on this device reuses its slot on the panel. */
    private fun deviceId(): String = runCatching {
        android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
    }.getOrNull().orEmpty()

    private fun deviceName(): String {
        val model = listOf(android.os.Build.MANUFACTURER, android.os.Build.MODEL)
            .filter { !it.isNullOrBlank() }
            .joinToString(" ")
            .trim()
        return model.ifBlank { "Android device" }
    }

    /** Turns the panel's {"message": "..."} error replies into text the user can read. */
    private fun panelErrorMessage(e: Throwable, fallback: String): String {
        if (e is HttpException) {
            val body = runCatching { e.response()?.errorBody()?.string() }.getOrNull().orEmpty()
            val message = runCatching { JSONObject(body).optString("message") }.getOrNull().orEmpty()
            if (message.isNotBlank()) return message
            return when (e.code()) {
                401 -> "Wrong username or password."
                403 -> "This account can't sign in right now. Please contact your provider."
                429 -> "Too many attempts. Please wait a few minutes and try again."
                else -> "The panel returned an error (${e.code()}). Please try again."
            }
        }
        if (e is java.io.IOException) return "Can't reach the panel. Check your internet connection."
        return e.message ?: fallback
    }

    /**
     * Confirms with the panel that this device may still use the app. A 401/403 means the line
     * was disabled, expired, removed or signed out from the panel, so the app signs out too.
     */
    private fun verifySessionWithPanel(accessToken: String) {
        panelScope.launch {
            try {
                val me = cockpitArvioApi.getMe("Bearer $accessToken").use { it.string() }
                val revision = runCatching { JSONObject(me).optString("addons_revision") }.getOrNull().orEmpty()
                val known = context.authDataStore.data.first()[PrefsKeys.PANEL_ADDONS_REVISION].orEmpty()
                if (revision.isNotBlank() && revision != known) {
                    syncPanelAddons(accessToken)
                }
                val meJson = runCatching { JSONObject(me) }.getOrNull()
                val configRevision = meJson?.optString("config_revision").orEmpty()
                if (configRevision.isNotBlank() && configRevision != com.arflix.tv.util.PanelKeys.revision) {
                    syncPanelConfig(accessToken)
                }
                val vpnRevision = meJson?.optString("vpn_revision").orEmpty()
                if (vpnRevision.isNotBlank() && vpnRevision != com.arflix.tv.vpn.VpnController.revision) {
                    syncPanelVpn(accessToken)
                }
                val collectionsRevision = meJson?.optString("collections_revision").orEmpty()
                if (collectionsRevision.isNotBlank()) {
                    syncPanelCollections(accessToken, collectionsRevision)
                }
            } catch (e: HttpException) {
                if (e.code() == 401 || e.code() == 403) {
                    AppLogger.breadcrumb("Auth", "panel_session_rejected code=${e.code()}", severity = "warning")
                    signOut(notifyPanel = false)
                }
            } catch (_: Exception) {
                // Offline or panel unreachable: keep the user signed in.
            }
        }
    }

    /** Installs/removes the addons the panel assigns to this line. */
    private suspend fun syncPanelAddons(accessToken: String) {
        try {
            val body = cockpitArvioApi.getAddons("Bearer $accessToken").use { it.string() }
            val root = JSONObject(body)
            val list = root.optJSONArray("addons")
            val specs = buildList {
                if (list != null) {
                    for (i in 0 until list.length()) {
                        val o = list.optJSONObject(i) ?: continue
                        val url = o.optString("url")
                        if (url.isBlank()) continue
                        add(
                            PanelAddonSpec(
                                key = o.optString("key").ifBlank { url },
                                url = url,
                                name = o.optString("name").takeIf { !o.isNull("name") && it.isNotBlank() }
                            )
                        )
                    }
                }
            }
            val removedJson = root.optJSONArray("removed_urls")
            val removed = buildList {
                if (removedJson != null) for (i in 0 until removedJson.length()) add(removedJson.optString(i))
            }.filter { it.isNotBlank() }
            val complete = streamRepositoryProvider.get().applyPanelAddons(specs, removed)
            if (complete) {
                context.authDataStore.edit { it[PrefsKeys.PANEL_ADDONS_REVISION] = root.optString("revision") }
            }
            AppLogger.breadcrumb("Auth", "panel_addons_applied count=${specs.size} complete=$complete")
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (e is HttpException && (e.code() == 401 || e.code() == 403)) {
                signOut(notifyPanel = false)
            }
            AppLogger.breadcrumb("Auth", "panel_addons_failed ${e.javaClass.simpleName}", severity = "warning")
        }
    }

    /** Loads the API keys set in the panel; the built-in keys stay in use for any it leaves empty. */
    private suspend fun syncPanelConfig(accessToken: String) {
        try {
            val body = cockpitArvioApi.getConfig("Bearer $accessToken").use { it.string() }
            com.arflix.tv.util.PanelKeys.apply(body)
            AppLogger.breadcrumb("Auth", "panel_config_applied")
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            AppLogger.breadcrumb("Auth", "panel_config_failed ${e.javaClass.simpleName}", severity = "warning")
        }
    }

    /** Loads the panel's VPN servers for the VPN switch in Settings. */
    private suspend fun syncPanelVpn(accessToken: String) {
        try {
            val body = cockpitArvioApi.getVpn("Bearer $accessToken").use { it.string() }
            com.arflix.tv.vpn.VpnController.applyPanel(body)
            AppLogger.breadcrumb("Auth", "panel_vpn_applied")
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            AppLogger.breadcrumb("Auth", "panel_vpn_failed ${e.javaClass.simpleName}", severity = "warning")
        }
    }

    private fun panelCollectionsDir(): java.io.File =
        java.io.File(context.filesDir, "panel_collections").apply { mkdirs() }

    /**
     * Installs the panel's collection packs in every profile. Each pack version is downloaded
     * once and kept on the device, so later starts (and new profiles) need no download.
     * [knownRevision] is the panel's current revision from me.php; null forces a check.
     */
    private suspend fun syncPanelCollections(accessToken: String, knownRevision: String? = null) {
        try {
            val profileIds = runCatching { profileRepositoryProvider.get().getProfiles().map { it.id } }
                .getOrDefault(emptyList()).sorted()
            val stored = context.authDataStore.data.first()[PrefsKeys.PANEL_COLLECTIONS_STATE].orEmpty()
            if (knownRevision != null && stored == "$knownRevision|${profileIds.joinToString(",")}") return

            val root = JSONObject(cockpitArvioApi.getCollections("Bearer $accessToken").use { it.string() })
            val revision = root.optString("revision")
            val list = root.optJSONArray("collections")
            val dir = panelCollectionsDir()
            var complete = true
            val packs = mutableListOf<PanelCollectionPack>()
            val keep = mutableSetOf<String>()
            if (list != null) {
                for (i in 0 until list.length()) {
                    val o = list.optJSONObject(i) ?: continue
                    val id = o.optInt("id")
                    val key = o.optString("key").replace(Regex("[^A-Za-z0-9_-]"), "")
                    if (id <= 0 || key.isBlank()) continue
                    val file = java.io.File(dir, "$key.json")
                    val json = if (file.isFile) {
                        file.readText()
                    } else {
                        runCatching {
                            cockpitArvioApi.getCollection("Bearer $accessToken", id).use { it.string() }
                        }.onFailure {
                            if (it is kotlinx.coroutines.CancellationException) throw it
                            complete = false
                        }.getOrNull()?.also { file.writeText(it) }
                    } ?: continue
                    keep += file.name
                    packs += PanelCollectionPack(id, o.optString("name").takeIf { !o.isNull("name") && it.isNotBlank() }, json)
                }
            }
            val removedJson = root.optJSONArray("removed_ids")
            val removed = buildList {
                if (removedJson != null) for (i in 0 until removedJson.length()) add(removedJson.optInt(i))
            }.filter { it > 0 }
            val changed = catalogRepositoryProvider.get().applyPanelCollections(profileIds, packs, removed)
            dir.listFiles()?.filter { it.name !in keep }?.forEach { it.delete() }
            if (complete) {
                context.authDataStore.edit {
                    it[PrefsKeys.PANEL_COLLECTIONS_STATE] = "$revision|${profileIds.joinToString(",")}"
                }
            }
            AppLogger.breadcrumb("Auth", "panel_collections_applied packs=${packs.size} profilesChanged=$changed complete=$complete")
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (e is HttpException && (e.code() == 401 || e.code() == 403)) {
                signOut(notifyPanel = false)
            }
            AppLogger.breadcrumb("Auth", "panel_collections_failed ${e.javaClass.simpleName}", severity = "warning")
        }
    }

    suspend fun checkAuthState() {
        try {
            val prefs = context.authDataStore.data.first()
            val accessToken = prefs[PrefsKeys.ACCESS_TOKEN]
            val cachedUserId = prefs[PrefsKeys.USER_ID]
            val cachedEmail = prefs[PrefsKeys.USER_EMAIL]

            if (!accessToken.isNullOrBlank() && !cachedUserId.isNullOrBlank()) {
                val email = cachedEmail ?: "user@xtream.local"
                val profile = UserProfile(id = cachedUserId, email = email)
                _userProfile.value = profile
                _authState.value = AuthState.Authenticated(cachedUserId, email, profile)
                runCatching { provisionPanelAddonsFromCloud() }
                verifySessionWithPanel(accessToken)
            } else {
                _authState.value = AuthState.NotAuthenticated
            }
        } catch (e: Exception) {
            _authState.value = AuthState.NotAuthenticated
        }
    }

    suspend fun signIn(username: String, password: String, serverUrl: String = "", serverId: Int? = null): Result<Unit> {
        if (username.isBlank() || password.isBlank()) {
            val msg = "Username and password are required"
            _authState.value = AuthState.Error(msg)
            return Result.failure(Exception(msg))
        }
        return try {
            AppLogger.breadcrumb("Auth", "panel_sign_in_start")
            _authState.value = AuthState.Loading

            val response = cockpitArvioApi.login(
                com.arflix.tv.data.api.ArvioLoginRequest(
                    username = username,
                    password = password,
                    deviceName = deviceName(),
                    serverUrl = serverUrl.trim(),
                    deviceId = deviceId(),
                    serverId = serverId
                )
            )

            val user = response.user
            val tokens = response.tokens

            storeRawSessionTokens(
                accessToken = tokens.accessToken,
                refreshToken = tokens.refreshToken,
                userId = user.id,
                email = user.email,
                accountSyncPayload = response.accountSyncPayload
            )
            provisionPanelAddons(response.addons, response.accountSyncPayload)

            context.authDataStore.edit { prefs ->
                prefs[stringPreferencesKey("server_url")] = user.serverUrl
                prefs[stringPreferencesKey("username")] = username
                prefs[stringPreferencesKey("password")] = password
                prefs[PrefsKeys.DISPLAY_NAME] = user.displayName
            }

            val profile = UserProfile(
                id = user.id,
                email = user.email
            )
            _userProfile.value = profile
            _authState.value = AuthState.Authenticated(user.id, user.email, profile)

            AppLogger.breadcrumb("Auth", "panel_sign_in_success")
            // Install this line's panel addons in the background; sign-in does not wait for it.
            panelScope.launch {
                syncPanelConfig(tokens.accessToken)
                syncPanelVpn(tokens.accessToken)
                syncPanelAddons(tokens.accessToken)
                syncPanelCollections(tokens.accessToken)
            }
            Result.success(Unit)
        } catch (e: Exception) {
            val message = panelErrorMessage(e, "Sign in failed")
            _authState.value = AuthState.Error(message)
            AppLogger.breadcrumb("Auth", "panel_sign_in_failed", severity = "warning")
            Result.failure(Exception(message))
        }
    }

    suspend fun signUp(email: String, password: String): Result<Unit> {
        return Result.failure(Exception("Sign up disabled"))
    }

    suspend fun signInWithSessionTokens(accessToken: String, refreshToken: String): Result<Unit> {
        return Result.failure(Exception("Session import disabled"))
    }

    suspend fun signOut() {
        signOut(notifyPanel = true)
    }

    private suspend fun signOut(notifyPanel: Boolean) {
        if (notifyPanel) {
            // Free this device's slot on the panel; never block sign-out on it.
            val token = runCatching { context.authDataStore.data.first()[PrefsKeys.ACCESS_TOKEN] }.getOrNull()
            if (!token.isNullOrBlank()) {
                runCatching {
                    kotlinx.coroutines.withTimeoutOrNull(5_000) { cockpitArvioApi.logout("Bearer $token").close() }
                }
            }
        }
        // The VPN belongs to the signed-in line.
        runCatching { com.arflix.tv.vpn.VpnController.clear() }
        try {
            traktRepositoryProvider.get().logout()
        } catch (e: Exception) {}
        context.authDataStore.edit { prefs -> prefs.clear() }
        context.settingsDataStore.edit { prefs -> prefs.clear() }
        _userProfile.value = null
        _authState.value = AuthState.NotAuthenticated
    }

    fun getTraktAccessToken(): String? = null
    fun isTraktLinked(): Boolean = false

    fun getCurrentUserId(): String? {
        return when (val state = _authState.value) {
            is AuthState.Authenticated -> state.userId
            else -> null
        }
    }

    suspend fun getCurrentUserIdForSync(): String? = getCurrentUserId()
    fun getCurrentUserEmail(): String? = _userProfile.value?.email
    suspend fun hasValidCloudSyncSession(): Boolean = getCurrentUserId() != null

    suspend fun getAccessToken(): String? {
        return context.authDataStore.data.first()[PrefsKeys.ACCESS_TOKEN]
    }

    suspend fun refreshAccessToken(): String? = getAccessToken()

    private suspend fun storeRawSessionTokens(
        accessToken: String,
        refreshToken: String,
        userId: String,
        email: String?,
        accountSyncPayload: String? = null
    ) {
        context.authDataStore.edit { prefs ->
            prefs[PrefsKeys.ACCESS_TOKEN] = accessToken
            prefs[PrefsKeys.REFRESH_TOKEN] = refreshToken
            prefs[PrefsKeys.USER_ID] = userId
            if (!email.isNullOrBlank()) {
                prefs[PrefsKeys.USER_EMAIL] = email
            }
            if (!accountSyncPayload.isNullOrBlank()) {
                prefs[PrefsKeys.ACCOUNT_SYNC_PAYLOAD] = accountSyncPayload
            }
        }
    }

    fun getAddonsFromProfile(): String? = null
    suspend fun getAddonsFromProfileFresh(): Result<String?> = Result.success(null)
    suspend fun saveAddonsToProfile(addonsJson: String): Result<Unit> = Result.success(Unit)

    fun getDefaultSubtitleFromProfile(): String? = null
    suspend fun saveDefaultSubtitleToProfile(subtitle: String?): Result<Unit> = Result.success(Unit)

    fun getAutoPlayNextFromProfile(): Boolean? = null
    suspend fun saveAutoPlayNextToProfile(autoPlayNext: Boolean): Result<Unit> = Result.success(Unit)

    suspend fun loadAccountSyncPayload(): Result<String?> {
        return try {
            val prefs = context.authDataStore.data.first()
            val accessToken = prefs[PrefsKeys.ACCESS_TOKEN]
            if (accessToken.isNullOrBlank()) {
                return Result.success(prefs[PrefsKeys.ACCOUNT_SYNC_PAYLOAD])
            }

            // Kept as raw text: profiles, settings and playlists must round-trip untouched.
            val json = cockpitArvioApi.getAccountSyncPayload("Bearer $accessToken").use { it.string() }.trim()
            val isEmpty = json.isBlank() || runCatching { JSONObject(json).length() == 0 }.getOrDefault(true)
            if (isEmpty) {
                return Result.success(prefs[PrefsKeys.ACCOUNT_SYNC_PAYLOAD])
            }
            context.authDataStore.edit { editPrefs ->
                editPrefs[PrefsKeys.ACCOUNT_SYNC_PAYLOAD] = json
            }
            Result.success(json)
        } catch (e: Exception) {
            if (e is HttpException && (e.code() == 401 || e.code() == 403)) {
                signOut(notifyPanel = false)
            }
            val cached = context.authDataStore.data.first()[PrefsKeys.ACCOUNT_SYNC_PAYLOAD]
            if (!cached.isNullOrBlank()) {
                Result.success(cached)
            } else {
                Result.failure(e)
            }
        }
    }

    suspend fun saveAccountSyncPayload(payload: String): Result<Unit> {
        return try {
            context.authDataStore.edit { prefs ->
                prefs[PrefsKeys.ACCOUNT_SYNC_PAYLOAD] = payload
            }
            val accessToken = context.authDataStore.data.first()[PrefsKeys.ACCESS_TOKEN]
            if (accessToken.isNullOrBlank()) {
                return Result.failure(IllegalStateException("Not signed in"))
            }
            // Upload so this line's other devices load the same profiles and settings.
            cockpitArvioApi.saveAccountSyncPayload(
                "Bearer $accessToken",
                payload.toRequestBody("application/json; charset=utf-8".toMediaType())
            ).close()
            Result.success(Unit)
        } catch (e: Exception) {
            if (e is HttpException && (e.code() == 401 || e.code() == 403)) {
                signOut(notifyPanel = false)
            }
            Result.failure(e)
        }
    }

    suspend fun mutateAccountSyncPayload(mutator: (JSONObject) -> Unit): Result<Unit> {
        return try {
            val current = loadAccountSyncPayload().getOrNull().orEmpty()
            val root = if (current.isBlank()) JSONObject() else JSONObject(current)
            mutator(root)
            saveAccountSyncPayload(root.toString())
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private suspend fun provisionPanelAddonsFromCloud() {
        val payload = loadAccountSyncPayload().getOrNull().orEmpty()
        provisionPanelAddons(emptyList(), payload)
    }

    private suspend fun provisionPanelAddons(responseAddons: List<Addon>, accountSyncPayload: String?) {
        val addons = responseAddons.takeIf { it.isNotEmpty() }
            ?: addonsFromAccountSyncPayload(accountSyncPayload.orEmpty())

        if (addons.isNotEmpty()) {
            streamRepositoryProvider.get().replaceSharedAddonsFromCloud(addons)
        }
    }

    private fun addonsFromAccountSyncPayload(payload: String): List<Addon> {
        if (payload.isBlank()) return emptyList()

        return runCatching {
            val root = JSONObject(payload)
            val addonsJson = root.optJSONArray("addons")?.toString().orEmpty()
            if (addonsJson.isBlank()) return@runCatching emptyList()

            val type = TypeToken.getParameterized(List::class.java, Addon::class.java).type
            gson.fromJson<List<Addon>>(addonsJson, type) ?: emptyList()
        }.getOrDefault(emptyList())
    }
}
