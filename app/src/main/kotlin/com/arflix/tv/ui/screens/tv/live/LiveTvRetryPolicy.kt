package com.arflix.tv.ui.screens.tv.live

import androidx.media3.common.util.StuckPlayerException

/** How long a live stream may buffer without its buffer moving before it counts as stalled. */
internal const val LIVE_STUCK_BUFFERING_TIMEOUT_MS = 12_000

/** True when the player gave up because buffering stopped making progress, not on a load error. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal fun Throwable.isStuckBuffering(): Boolean =
    generateSequence(this) { it.cause }.any { cause ->
        cause is StuckPlayerException && (
            cause.stuckType == StuckPlayerException.STUCK_BUFFERING_NO_PROGRESS ||
                cause.stuckType == StuckPlayerException.STUCK_BUFFERING_NOT_LOADING
            )
    }

private val terminalPlaybackHttpCodes = setOf(401, 403, 429, 444, 451, 513)

internal fun isMissingPlaybackResource(httpCode: Int?): Boolean = httpCode == 404 || httpCode == 410

internal fun shouldReusePreparedLiveHls(
    preparedIsHls: Boolean,
    isCatchup: Boolean,
    unsupportedContainer: Boolean,
    httpCode: Int?,
): Boolean = preparedIsHls && !isCatchup && !unsupportedContainer && !isMissingPlaybackResource(httpCode)

internal fun shouldRetryLiveTvPlayback(
    httpCode: Int?,
    nextAttempt: Int,
    maxRetryCount: Int,
    isCatchup: Boolean,
): Boolean {
    if (nextAttempt > maxRetryCount || httpCode in terminalPlaybackHttpCodes) return false
    // Any live source can redirect to an expired URL. Refresh once before giving up;
    // catch-up retains its existing bounded budget for different archive candidates.
    return isCatchup || !isMissingPlaybackResource(httpCode) || nextAttempt == 1
}
