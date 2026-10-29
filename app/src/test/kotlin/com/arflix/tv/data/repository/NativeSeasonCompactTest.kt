package com.arflix.tv.data.repository

import com.arflix.tv.data.api.StremioMetaPreview
import com.arflix.tv.data.api.StremioMetaVideo
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeSeasonCompactTest {
    private fun meta(vararg v: StremioMetaVideo) = StremioMetaPreview(id = "plexio:x", name = "Boxing", videos = v.toList())

    @Test
    fun `year numbered seasons become 1 to K and streams still resolve`() {
        val m = meta(
            StremioMetaVideo(id = "a", season = 2026, episode = 1),
            StremioMetaVideo(id = "b", season = 2025, episode = 3),
            StremioMetaVideo(id = "c", season = 0, episode = 1)
        )
        val c = compactNativeSeasons(m)
        assertEquals(listOf(2, 1, 0), c.videos!!.map { it.season })
        assertEquals("a", nativeEpisodeStreamId(m, 2, 1))
        assertEquals("b", nativeEpisodeStreamId(m, 1, 3))
    }

    @Test
    fun `normal seasons are left alone`() {
        val m = meta(StremioMetaVideo(id = "a", season = 1, episode = 1), StremioMetaVideo(id = "b", season = 3, episode = 1))
        assertEquals(m, compactNativeSeasons(m))
        assertEquals("b", nativeEpisodeStreamId(m, 3, 1))
    }
}
