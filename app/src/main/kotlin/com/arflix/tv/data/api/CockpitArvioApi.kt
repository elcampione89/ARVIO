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

    /** Frees this device's slot on the panel. */
    @POST("logout.php")
    suspend fun logout(@Header("Authorization") authorization: String): ResponseBody
}
