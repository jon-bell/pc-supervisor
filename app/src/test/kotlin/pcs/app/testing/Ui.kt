package pcs.app.testing

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.v2.runDesktopComposeUiTest

/** Every UI test runs in the same fixed window at the harness default scale of 1.0 (density 1f; the test window has no display scaling), so screenshots don't depend on the machine. */
const val WINDOW_WIDTH = 1280
const val WINDOW_HEIGHT = 1400

@OptIn(ExperimentalTestApi::class)
fun runUi(block: ComposeUiTest.() -> Unit) = runDesktopComposeUiTest(WINDOW_WIDTH, WINDOW_HEIGHT) { block() }

@OptIn(ExperimentalTestApi::class)
fun ComposeUiTest.screenshot(name: String) {
    waitForIdle()
    Visual.capture(onRoot(), name)
}
