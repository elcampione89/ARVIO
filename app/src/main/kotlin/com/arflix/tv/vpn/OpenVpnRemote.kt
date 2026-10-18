package com.arflix.tv.vpn

import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Parcel

/**
 * Client for the remote-control interface that "OpenVPN for Android" (de.blinkt.openvpn)
 * publishes for other apps (service action `de.blinkt.openvpn.api.IOpenVPNAPIService`).
 *
 * Calls are made directly over the Binder instead of through generated AIDL classes. Each
 * method's transaction code is its position in the published interface, so the order below
 * must match it: getProfiles, startProfile, addVPNProfile, startVPN, prepare,
 * prepareVPNService, disconnect, pause, resume, registerStatusCallback, ...
 */
class OpenVpnRemote(private val binder: IBinder) {

    fun startVpn(inlineConfig: String) = call(TX_START_VPN) { it.writeString(inlineConfig) }

    /** Null when this app may control OpenVPN for Android; otherwise an Intent asking the user. */
    fun prepare(packageName: String): Intent? = callForIntent(TX_PREPARE) { it.writeString(packageName) }

    /** Null when OpenVPN for Android already has Android's VPN permission; otherwise an Intent asking for it. */
    fun prepareVpnService(): Intent? = callForIntent(TX_PREPARE_VPN_SERVICE) {}

    fun disconnect() = call(TX_DISCONNECT) {}

    fun registerStatusCallback(callback: StatusCallback) = call(TX_REGISTER_STATUS_CALLBACK) {
        it.writeStrongBinder(callback)
    }

    fun unregisterStatusCallback(callback: StatusCallback) = call(TX_UNREGISTER_STATUS_CALLBACK) {
        it.writeStrongBinder(callback)
    }

    private fun call(code: Int, write: (Parcel) -> Unit) {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
            data.writeInterfaceToken(DESCRIPTOR)
            write(data)
            binder.transact(code, data, reply, 0)
            reply.readException()
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    private fun callForIntent(code: Int, write: (Parcel) -> Unit): Intent? {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
            data.writeInterfaceToken(DESCRIPTOR)
            write(data)
            binder.transact(code, data, reply, 0)
            reply.readException()
            return if (reply.readInt() != 0) Intent.CREATOR.createFromParcel(reply) else null
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    /**
     * Receives OpenVPN for Android's status updates (its one-way IOpenVPNStatusCallback):
     * newStatus(uuid, state, message, level), where level is e.g. LEVEL_CONNECTED.
     */
    class StatusCallback(
        private val onStatus: (state: String, message: String, level: String) -> Unit
    ) : Binder() {
        init {
            attachInterface(null, CALLBACK_DESCRIPTOR)
        }

        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code == IBinder.FIRST_CALL_TRANSACTION) {
                data.enforceInterface(CALLBACK_DESCRIPTOR)
                data.readString() // profile uuid
                val state = data.readString().orEmpty()
                val message = data.readString().orEmpty()
                val level = data.readString().orEmpty()
                onStatus(state, message, level)
                return true
            }
            return super.onTransact(code, data, reply, flags)
        }
    }

    companion object {
        const val PACKAGE = "de.blinkt.openvpn"
        const val SERVICE_ACTION = "de.blinkt.openvpn.api.IOpenVPNAPIService"
        private const val DESCRIPTOR = "de.blinkt.openvpn.api.IOpenVPNAPIService"
        private const val CALLBACK_DESCRIPTOR = "de.blinkt.openvpn.api.IOpenVPNStatusCallback"

        private const val TX_START_VPN = IBinder.FIRST_CALL_TRANSACTION + 3
        private const val TX_PREPARE = IBinder.FIRST_CALL_TRANSACTION + 4
        private const val TX_PREPARE_VPN_SERVICE = IBinder.FIRST_CALL_TRANSACTION + 5
        private const val TX_DISCONNECT = IBinder.FIRST_CALL_TRANSACTION + 6
        private const val TX_REGISTER_STATUS_CALLBACK = IBinder.FIRST_CALL_TRANSACTION + 9
        private const val TX_UNREGISTER_STATUS_CALLBACK = IBinder.FIRST_CALL_TRANSACTION + 10
    }
}
