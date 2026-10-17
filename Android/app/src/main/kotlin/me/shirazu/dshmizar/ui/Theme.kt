package me.shirazu.dshmizar.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** The panel's own accent, so a Mizar screen is recognisable as one. */
private val MizarBlue = Color(0xFF2F6FED)
private val MizarBlueDark = Color(0xFF8FB4FF)

private val Light = lightColorScheme(primary = MizarBlue)
private val Dark = darkColorScheme(primary = MizarBlueDark)

/**
 * The theme.
 *
 * Material 3's defaults with one accent, and **no dynamic colour**: the panel is a
 * tool an operator reads under pressure, and a palette that changes with the
 * wallpaper changes what "orange means waiting for you" looks like.
 */
@Composable
fun MizarTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}

/** The colours an approval or a failure is drawn in, kept out of the scheme. */
object MizarColors {
    val Warning = Color(0xFFB26A00)
    val WarningFill = Color(0x1FB26A00)
    val Info = Color(0xFF1B5E9C)
    val InfoFill = Color(0x1A1B5E9C)
    val Failure = Color(0xFFB3261E)
    val FailureFill = Color(0x1AB3261E)
}
