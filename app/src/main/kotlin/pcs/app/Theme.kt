package pcs.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Screenshot mode (PLAN M4, visual review): times that change from run to run render as a fixed
 * mask, so two runs of the UI tests produce identical images.
 */
val LocalScreenshotMode = staticCompositionLocalOf { false }

/** The bundled font (SIL OFL, resources/fonts/OFL.txt), so rendering doesn't depend on the machine's fonts. */
private val inter: FontFamily by lazy {
    fun font(file: String, weight: FontWeight) =
        Font(
            identity = file,
            data = Theme::class.java.getResourceAsStream("/fonts/$file")!!.use { it.readBytes() },
            weight = weight,
        )
    FontFamily(font("Inter-Regular.otf", FontWeight.Normal), font("Inter-SemiBold.otf", FontWeight.SemiBold))
}

object Theme {
    val colors: ColorScheme =
        lightColorScheme(
            primary = Color(0xFF1F5F8B),
            secondary = Color(0xFF4F6D7A),
            surface = Color(0xFFFFFFFF),
            background = Color(0xFFF7F8FA),
            surfaceVariant = Color(0xFFEDEFF3),
            error = Color(0xFFB3261E),
        )

    fun typography(): Typography {
        val base = Typography()

        fun TextStyle.f() = copy(fontFamily = inter)
        return Typography(
            headlineSmall = base.headlineSmall.f().copy(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
            titleMedium = base.titleMedium.f().copy(fontWeight = FontWeight.SemiBold),
            titleSmall = base.titleSmall.f().copy(fontWeight = FontWeight.SemiBold),
            bodyLarge = base.bodyLarge.f(),
            bodyMedium = base.bodyMedium.f().copy(fontSize = 13.sp),
            bodySmall = base.bodySmall.f(),
            labelLarge = base.labelLarge.f().copy(fontWeight = FontWeight.SemiBold),
            labelMedium = base.labelMedium.f(),
            labelSmall = base.labelSmall.f(),
        )
    }
}

@Composable
fun PcsTheme(screenshotMode: Boolean = false, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalScreenshotMode provides screenshotMode) {
        MaterialTheme(colorScheme = Theme.colors, typography = Theme.typography(), content = content)
    }
}

/** A time that changes between runs (a sync timestamp, "3 min ago"): masked in screenshot mode. */
@Composable
fun MaskedText(text: String, tag: String, modifier: Modifier = Modifier, widthDp: Int = 160) {
    if (LocalScreenshotMode.current) {
        // the text stays in the semantics tree for the view reader, but draws nothing over a fixed box
        Box(modifier.width(widthDp.dp).clipToBounds().background(Color(0xFFB0B4BA))) {
            Text(text, Modifier.testTag(tag), color = Color.Transparent, maxLines = 1, softWrap = false, style = MaterialTheme.typography.bodyMedium)
        }
    } else {
        Text(text, modifier.testTag(tag), style = MaterialTheme.typography.bodyMedium)
    }
}
