package pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pcs.core.secrets.Keychain
import pcs.core.session.AppDirs
import pcs.core.session.Conference
import pcs.core.session.Conferences
import pcs.core.session.Session
import java.net.URI

/** Opens a HotCRP page in the system browser. Tests substitute a recorder; nothing else ever opens a URL. */
fun interface UrlOpener {
    fun open(url: String)
}

/** The real thing: the desktop's default browser, for http(s) links only. */
object SystemBrowser : UrlOpener {
    override fun open(url: String) {
        val u = URI(url)
        require(u.scheme == "http" || u.scheme == "https") { "not a web link: $url" }
        java.awt.Desktop.getDesktop().browse(u)
    }
}

/**
 * Everything the app gets from outside: the environment (where the conference files are), the
 * keychain, and the browser. Tests pass a fake keychain and a recording opener; the secrets
 * themselves never come through here (AGENTS.md non-negotiable 5).
 */
class Shell(
    val env: Map<String, String>,
    val keychain: () -> Keychain,
    val opener: UrlOpener = SystemBrowser,
    /** Screenshot mode masks times that change from run to run. */
    val screenshotMode: Boolean = false,
)

object Tags {
    const val UNLOCK_STATUS = "unlock-status"
    const val UNLOCK_ERROR = "unlock-error"
    const val RETRY = "unlock-retry"
    const val PICKER = "conference-picker"
    const val PICKER_EMPTY = "conference-picker-empty"
    const val OPEN_ERROR = "open-error"
    const val TABS = "tabs"
    const val SYNC_NOW = "sync-now"
    const val SYNC_STATUS = "sync-status"
    const val LAST_SYNC = "last-sync"
    const val COPY_SEARCH = "copy-search"
    const val SEARCH_LINK = "search-link"
    const val DRAFT_ATTENTION = "draft-attention"
    const val DRAFT_ERROR = "draft-error"

    fun conference(id: String) = "conference-$id"

    fun tab(name: String) = "tab-$name"

    fun problem(id: String) = "conference-problem-$id"
}

private sealed interface Stage {
    data object Unlocking : Stage

    data class Failed(val message: String) : Stage

    data class Picking(val keychain: Keychain) : Stage

    data class Open(val session: Session, val keychain: Keychain) : Stage
}

/** The app: unlock the keychain, pick a conference, work in it. */
@Composable
fun PcsApp(shell: Shell) {
    PcsTheme(shell.screenshotMode) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            var attempt by remember { mutableStateOf(0) }
            var stage by remember { mutableStateOf<Stage>(Stage.Unlocking) }
            LaunchedEffect(attempt) {
                stage = Stage.Unlocking
                stage =
                    try {
                        // creating the keychain is what triggers the OS's unlock prompt
                        Stage.Picking(withContext(Dispatchers.IO) { shell.keychain() })
                    } catch (e: Exception) {
                        Stage.Failed(e.message ?: e.javaClass.simpleName)
                    }
            }
            when (val s = stage) {
                Stage.Unlocking -> Centered { Text("Unlocking the keychain…", Modifier.testTag(Tags.UNLOCK_STATUS)) }
                is Stage.Failed ->
                    Centered {
                        Text("PC Supervisor can't reach the keychain", style = MaterialTheme.typography.titleMedium)
                        Text(s.message, Modifier.testTag(Tags.UNLOCK_ERROR))
                        Text("The HotCRP token and the database key live there; nothing works without it.", style = MaterialTheme.typography.bodyMedium)
                        Button({ attempt++ }, Modifier.testTag(Tags.RETRY)) { Text("Try again") }
                    }
                is Stage.Picking -> Picker(shell, s.keychain) { stage = Stage.Open(it, s.keychain) }
                is Stage.Open -> {
                    DisposableEffect(s.session) { onDispose { s.session.close() } }
                    ConferenceScreen(shell, s.session) { stage = Stage.Picking(s.keychain) }
                }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        content()
    }
}

@Composable
private fun Picker(shell: Shell, keychain: Keychain, onOpen: (Session) -> Unit) {
    val conferences by remember { mutableStateOf(Conferences.list(shell.env)) }
    var error by remember { mutableStateOf<String?>(null) }
    var opening by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Centered {
        Text("Conferences", style = MaterialTheme.typography.headlineSmall)
        Text("Keychain: ${keychain.backend}", style = MaterialTheme.typography.bodyMedium)
        if (conferences.isEmpty()) {
            Text(
                "No conference files in ${AppDirs.conferences(shell.env)}. Add one <name>.conf there (see pcs.conf.example).",
                Modifier.testTag(Tags.PICKER_EMPTY),
            )
        }
        Column(Modifier.testTag(Tags.PICKER), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            conferences.forEach { c ->
                ConferenceRow(c, enabled = opening == null) {
                    opening = c.id
                    error = null
                    scope.launch {
                        try {
                            onOpen(withContext(Dispatchers.IO) { Session.open(c, keychain, shell.env) })
                        } catch (e: Exception) {
                            error = "${c.id}: ${e.message ?: e.javaClass.simpleName}"
                            opening = null
                        }
                    }
                }
            }
        }
        error?.let { Text(it, Modifier.testTag(Tags.OPEN_ERROR), color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun ConferenceRow(c: Conference, enabled: Boolean, onClick: () -> Unit) {
    val problems = c.problems
    Column {
        OutlinedButton(onClick, Modifier.testTag(Tags.conference(c.id)), enabled = enabled && problems.isEmpty()) {
            Text(c.id + (c.settings.getOrNull()?.let { "  •  ${it.hotcrpUrl}" } ?: ""))
        }
        problems.forEach { Text(it, Modifier.testTag(Tags.problem(c.id)), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}
