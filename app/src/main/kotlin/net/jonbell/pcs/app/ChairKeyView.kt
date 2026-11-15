package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import net.jonbell.pcs.core.session.Session
import java.nio.file.Files

object ChairKeyTags {
    const val SECTION = "chair-key-section"
    const val TEXT = "chair-key-text"
    const val FINGERPRINT = "chair-key-fingerprint"
    const val COPY = "chair-key-copy"
    const val SAVE = "chair-key-save"
    const val STATUS = "chair-key-status"
}

/**
 * This chair's public key for screening bundles (owner's ruling 2026-11-15: a bundle's content key is wrapped for each named chair, so no
 * shared secret travels). The keypair is made in the OS keychain on first view; only the public half is shown, copied or saved.
 * `pcs agent bundle --to` takes the line or the saved file.
 */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun ChairKeySection(session: Session) {
    val key = remember(session) { runCatching { session.chairPublicKey() } }
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>(null) }
    Column(Modifier.padding(vertical = 6.dp).testTag(ChairKeyTags.SECTION), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Screening bundle key", style = MaterialTheme.typography.titleSmall)
        Text(
            "Give this public key to whoever builds a screening bundle (`pcs agent bundle --to`). Your private key stays in the OS keychain and opens only bundles made for it.",
            style = MaterialTheme.typography.bodySmall,
        )
        key.fold(
            { k ->
                SelectionContainer { Text(k.text, Modifier.testTag(ChairKeyTags.TEXT), style = MaterialTheme.typography.bodySmall) }
                Text("Fingerprint ${k.fingerprint}", Modifier.testTag(ChairKeyTags.FINGERPRINT), style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({
                        scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(java.awt.datatransfer.StringSelection(k.text))) }
                        status = "Copied the public key."
                    }, Modifier.testTag(ChairKeyTags.COPY)) { Text("Copy public key") }
                    OutlinedButton({
                        status =
                            runCatching {
                                val dir = net.jonbell.pcs.core.report.ReportFiles.dir(session, System.getenv())
                                Files.createDirectories(dir)
                                val f = dir.resolve("chair-key.pub")
                                Files.writeString(f, k.text + "\n")
                                "Saved the public key to $f"
                            }.getOrElse { "Could not save: ${it.message}" }
                    }, Modifier.testTag(ChairKeyTags.SAVE)) { Text("Save public key") }
                }
            },
            {
                Text(
                    "No chair key: ${it.message}",
                    Modifier.testTag(ChairKeyTags.STATUS),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            },
        )
        status?.let { Text(it, Modifier.testTag(ChairKeyTags.STATUS), style = MaterialTheme.typography.bodySmall) }
    }
}
