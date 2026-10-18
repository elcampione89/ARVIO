package com.arflix.tv.data.api

import com.arflix.tv.data.model.Addon
import com.google.gson.annotations.SerializedName

data class ArvioLoginRequest(
    @SerializedName("username") val username: String,
    @SerializedName("password") val password: String,
    @SerializedName("device_name") val deviceName: String = "Android TV",
    @SerializedName("server_url") val serverUrl: String = "",
    @SerializedName("device_id") val deviceId: String = "",
    /** The chosen TV service's id; lets the panel keep server addresses private. */
    @SerializedName("server_id") val serverId: Int? = null
)

data class ArvioUser(
    @SerializedName("id") val id: String,
    @SerializedName("email") val email: String,
    @SerializedName("display_name") val displayName: String,
    @SerializedName("server_url") val serverUrl: String
)

data class ArvioTokens(
    @SerializedName("access_token") val accessToken: String,
    @SerializedName("refresh_token") val refreshToken: String,
    @SerializedName("token_type") val tokenType: String,
    @SerializedName("expires_in") val expiresIn: Long
)

data class ArvioLoginResponse(
    @SerializedName("user") val user: ArvioUser,
    @SerializedName("tokens") val tokens: ArvioTokens,
    @SerializedName("addons") val addons: List<Addon> = emptyList(),
    @SerializedName("account_sync_payload") val accountSyncPayload: String? = null
)

data class ArvioPortal(
    @SerializedName("id") val id: Int,
    @SerializedName("name") val name: String? = null,
    /** Empty when the panel hides server addresses; the app then signs in with [id]. */
    @SerializedName("url") val url: String? = null
)

data class ArvioPortalsResponse(
    @SerializedName("portals") val portals: List<ArvioPortal>
)

data class ArvioAccountSyncPayload(
    @SerializedName("schemaVersion") val schemaVersion: Int = 1,
    @SerializedName("updatedAt") val updatedAt: Long = 0,
    @SerializedName("addons") val addons: List<Addon> = emptyList(),
    @SerializedName("addonsByProfile") val addonsByProfile: Map<String, List<Addon>> = emptyMap()
)
