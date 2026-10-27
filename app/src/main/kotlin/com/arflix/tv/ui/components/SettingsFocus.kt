package com.arflix.tv.ui.components

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal fun Modifier.settingsFocusOutline(
    isFocused: Boolean,
    cornerRadius: Dp = 8.dp
): Modifier = if (!isFocused) this else drawWithCache {
    val inset = 0.75.dp.toPx()
    val origin = Offset(inset, inset)
    val bounds = Size((size.width - inset * 2).coerceAtLeast(0f), (size.height - inset * 2).coerceAtLeast(0f))
    val radius = CornerRadius((cornerRadius.toPx() - inset).coerceAtLeast(0f))
    val outerHalo = Stroke(6.dp.toPx())
    val innerHalo = Stroke(3.dp.toPx())
    val outline = Stroke(1.5.dp.toPx())
    onDrawWithContent {
        drawContent()
        // Cached strokes give a soft halo without blur or a delayed focus fade-out.
        drawRoundRect(Color.White.copy(alpha = 0.035f), origin, bounds, radius, style = outerHalo)
        drawRoundRect(Color.White.copy(alpha = 0.07f), origin, bounds, radius, style = innerHalo)
        drawRoundRect(Color.White.copy(alpha = 0.9f), origin, bounds, radius, style = outline)
    }
}
