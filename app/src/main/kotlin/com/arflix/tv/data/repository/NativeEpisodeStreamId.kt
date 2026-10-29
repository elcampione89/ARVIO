package com.arflix.tv.data.repository

import com.arflix.tv.data.api.StremioMetaPreview

/** Addon video IDs are opaque, not necessarily showId:season:episode. */
internal fun nativeEpisodeStreamId(meta: StremioMetaPreview?, season: Int, episode: Int): String? =
    meta?.let(::compactNativeSeasons)?.videos?.firstOrNull { it.season == season && it.episode == episode }
        ?.id?.takeIf { it.isNotBlank() }

/**
 * Some addons number seasons by year (Plex sports libraries served by Plexio: season 2026).
 * The details screen lists seasons 1..N, so a lone "season 2026" would show 2026 empty seasons.
 * When any season is over 100, seasons are renumbered 1..K in order (specials, season 0, stay).
 * Used for both the episode list and the stream lookup, so the two always agree.
 */
internal fun compactNativeSeasons(meta: StremioMetaPreview): StremioMetaPreview {
    val videos = meta.videos ?: return meta
    val seasons = videos.mapNotNull { it.season?.takeIf { s -> s > 0 } }.distinct().sorted()
    if (seasons.none { it > 100 }) return meta
    val rank = seasons.withIndex().associate { (i, s) -> s to i + 1 }
    return meta.copy(videos = videos.map { v -> v.season?.let { s -> rank[s] }?.let { v.copy(season = it) } ?: v })
}
