package net.jonbell.pcs.app.testing

import androidx.compose.ui.graphics.toAwtImage
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import java.io.File
import javax.imageio.ImageIO

/**
 * The one place screenshots are taken (PLAN M4, T12). Every capture is written with Compose's own
 * image capture to `app/build/screenshots/<name>.png`, which is what CI uploads. When Gradle is
 * run with `-Ppcs.visual=record|compare`, the capture also goes through Roborazzi against local
 * baselines in `app/visual-baselines/` (never committed), so a developer sees diffs offline. If
 * Roborazzi's Compose Desktop support breaks (it is newer than its Android support), the helper
 * says so once and carries on with the plain capture.
 */
object Visual {
    private val dir: File = File(System.getProperty("pcs.screenshots") ?: "build/screenshots")
    private val mode: String? = System.getProperty("pcs.visual")
    private var roborazziBroken = false

    /** [name] is claim-and-state, like `card-E7` or `golden/papers`. Returns the plain capture's file. */
    fun capture(node: SemanticsNodeInteraction, name: String): File {
        val out = File(dir, "$name.png").also { it.parentFile.mkdirs() }
        ImageIO.write(node.captureToImage().toAwtImage(), "png", out)
        if (mode != null && !roborazziBroken) viaRoborazzi(node, name)
        return out
    }

    private fun viaRoborazzi(node: SemanticsNodeInteraction, name: String) {
        try {
            val baseline = File(System.getProperty("pcs.visualBaselines")!!, "$name.png").also { it.parentFile.mkdirs() }
            RoborazziBridge.capture(node, baseline)
        } catch (e: AssertionError) {
            throw e // a visual difference, which is the point of compare mode
        } catch (e: Throwable) {
            roborazziBroken = true
            System.err.println("Roborazzi unavailable (${e.javaClass.simpleName}: ${e.message}); using plain image capture only")
        }
    }
}
