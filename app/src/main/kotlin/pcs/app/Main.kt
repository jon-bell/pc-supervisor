package pcs.app

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import pcs.core.readings.ModelExport
import pcs.core.secrets.OsKeychain
import pcs.core.session.Conferences
import kotlin.system.exitProcess

/** The app version, shown nowhere secret; the packaged installers carry the same number. */
const val APP_VERSION = "0.4.0"

fun main(args: Array<String>) {
    val shell = Shell(System.getenv(), { OsKeychain() })
    if ("--smoke" in args) exitProcess(smoke(shell))
    application {
        Window(onCloseRequest = ::exitApplication, title = "PC Supervisor", state = rememberWindowState(size = DpSize(1280.dp, 860.dp))) {
            PcsApp(shell)
        }
    }
}

/**
 * Headless start check for the packaged app (release workflow): the bundled resources load, the
 * conference files parse, and no window or keychain is opened. Exit code 0 means it starts.
 */
private fun smoke(shell: Shell): Int {
    val cards = ModelExport.cards.size
    val conferences = Conferences.list(shell.env)
    val font = Thread.currentThread().contextClassLoader.getResource("fonts/Inter-Regular.otf") != null
    println("pc-supervisor $APP_VERSION: $cards cards, ${conferences.size} conferences, bundled font ${if (font) "found" else "MISSING"}")
    return if (cards > 0 && font) 0 else 1
}
