package net.jonbell.pcs.app.testing

import androidx.compose.ui.test.SemanticsNodeInteraction
import io.github.takahirom.roborazzi.captureRoboImage
import java.io.File

/**
 * The only file that imports Roborazzi, so swapping it out touches nothing else. The mode comes
 * from the `roborazzi.test.*` system properties that app/build.gradle.kts sets from `-Ppcs.visual`.
 */
internal object RoborazziBridge {
    fun capture(node: SemanticsNodeInteraction, baseline: File) {
        node.captureRoboImage(baseline.path)
    }
}
