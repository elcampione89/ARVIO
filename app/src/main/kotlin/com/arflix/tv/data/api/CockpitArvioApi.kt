package com.arflix.tv.data.api

import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

interface CockpitArvioApi {

    @POST("api/auth/login")
    suspend fun login(@Body body: ArvioLoginRequest): ArvioLoginResponse

    @GET("portals.php")
    suspend fun getPortals(): ArvioPortalsResponse

    /** The line's saved profiles/settings, returned verbatim so nothing is dropped. */
    @GET("account.php")
    suspend fun getAccountSyncPayload(@Header("Authorization") authorization: String): ResponseBody

    /** Saves this device's profiles/settings so the line's other devices pick them up. */
    @POST("account.php")
    suspend fun saveAccountSyncPayload(
        @Header("Authorization") authorization: String,
        @Body payload: RequestBody
    ): ResponseBody

    /** Subscription check; the panel answers 401/403 when this device may no longer sign in. */
    @GET("me.php")
    suspend fun getMe(@Header("Authorization") authorization: String): ResponseBody

    /** Addons the panel assigns to this line, and panel addons to remove. */
    @GET("addons.php")
    suspend fun getAddons(@Header("Authorization") authorization: String): ResponseBody

    /** Collection packs the panel gives every line, and panel packs to remove. */
    @GET("collections.php")
    suspend fun getCollections(@Header("Authorization") authorization: String): ResponseBody

    /** One collection pack's collections JSON, returned verbatim. */
    @GET("collection.php")
    suspend fun getCollection(
        @Header("Authorization") authorization: String,
        @retrofit2.http.Query("id") id: Int
    ): ResponseBody

    /** API keys set in the panel (only the filled-in ones). Not "config.php": the panel blocks that name. */
    @GET("keys.php")
    suspend fun getConfig(@Header("Authorization") authorization: String): ResponseBody

    /** VPN servers (WireGuard via wg-easy) when the panel offers the VPN. */
    @GET("vpn.php")
    suspend fun getVpn(@Header("Authorization") authorization: String): ResponseBody

    /** This device's WireGuard config for a VPN server; the panel creates it on first use. */
    @GET("vpnconfig.php")
    suspend fun getVpnConfig(
        @Header("Authorization") authorization: String,
        @retrofit2.http.Query("server") serverId: Int
    ): ResponseBody

    /** Frees this device's slot on the panel. */
    @POST("logout.php")
    suspend fun logout(@Header("Authorization") authorization: String): ResponseBody
}
