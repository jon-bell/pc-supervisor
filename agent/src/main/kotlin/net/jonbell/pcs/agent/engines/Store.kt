package net.jonbell.pcs.agent.engines

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap

/** What the store keeps per key: an engine result, or the findings of a deterministic check (engine `local`). */
@Serializable
data class StoredResult(
    val key: String,
    val checkId: String,
    val checkVersion: String,
    val engineId: String,
    val paperId: String,
    val dataClass: DataClass,
    val result: CallResult? = null,
    val findings: JsonElement? = null,
)

/** The content-addressed result store (agent.md §4.4). */
interface ResultStore {
    fun get(key: String): StoredResult?

    fun put(r: StoredResult)

    fun all(): List<StoredResult>
}

class InMemoryResultStore : ResultStore {
    private val m = ConcurrentHashMap<String, StoredResult>()

    override fun get(key: String) = m[key]

    override fun put(r: StoredResult) {
        m[r.key] = r
    }

    override fun all() = m.values.toList()
}

/**
 * One JSON file per key. Plain files, so it takes synthetic and public data only: a confidential
 * result needs the encrypted store (agent.md §5.4), which arrives with the screening bundle (M12),
 * and this class refuses to write one rather than leave it in the clear.
 */
class FileResultStore(private val dir: Path) : ResultStore {
    private val json = Json { encodeDefaults = true }

    init {
        Files.createDirectories(dir)
    }

    override fun get(key: String): StoredResult? {
        require(key.matches(Regex("[0-9a-f]{64}"))) { "not a content address: $key" }
        val f = dir.resolve("$key.json")
        return if (Files.isRegularFile(f)) json.decodeFromString(StoredResult.serializer(), Files.readString(f)) else null
    }

    override fun put(r: StoredResult) {
        require(r.dataClass != DataClass.CONFIDENTIAL) { "the file store holds synthetic and public data only; confidential results need the encrypted store" }
        require(r.key.matches(Regex("[0-9a-f]{64}"))) { "not a content address: ${r.key}" }
        val tmp = Files.createTempFile(dir, "put-", ".tmp")
        Files.writeString(tmp, json.encodeToString(StoredResult.serializer(), r))
        Files.move(tmp, dir.resolve("${r.key}.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    override fun all(): List<StoredResult> =
        Files.list(dir).use { s -> s.filter { it.fileName.toString().endsWith(".json") }.toList() }
            .map { json.decodeFromString(StoredResult.serializer(), Files.readString(it)) }
}

/**
 * The encrypted content-addressed store (agent.md §5.4): one file per key, each sealed with AES-256-GCM under the
 * store key (the same 32-byte key format as a bundle's, from `PCS_AGENT_STORE_KEY_FILE`), the file's content address
 * authenticated as associated data so a result cannot be moved to another key. Unlike [FileResultStore] it takes
 * `confidential` results: extracted-text-derived findings, raw model output and all.
 */
class EncryptedFileResultStore(private val dir: Path, private val key: net.jonbell.pcs.core.bundle.BundleKey) : ResultStore {
    private val json = Json { encodeDefaults = true }

    init {
        Files.createDirectories(dir)
    }

    private fun aad(k: String) = ("pcs-agent-store-v1 $k").toByteArray()

    override fun get(key: String): StoredResult? {
        require(key.matches(Regex("[0-9a-f]{64}"))) { "not a content address: $key" }
        val f = dir.resolve("$key.enc")
        if (!Files.isRegularFile(f)) return null
        val plain =
            try {
                this.key.open(Files.readAllBytes(f), aad(key))
            } catch (e: java.security.GeneralSecurityException) {
                throw IllegalStateException("the store entry $key did not decrypt: wrong store key, or the file was changed")
            }
        return json.decodeFromString(StoredResult.serializer(), plain.toString(Charsets.UTF_8))
    }

    override fun put(r: StoredResult) {
        require(r.key.matches(Regex("[0-9a-f]{64}"))) { "not a content address: ${r.key}" }
        val tmp = Files.createTempFile(dir, "put-", ".tmp")
        Files.write(tmp, key.seal(json.encodeToString(StoredResult.serializer(), r).toByteArray(), aad(r.key)))
        Files.move(tmp, dir.resolve("${r.key}.enc"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    override fun all(): List<StoredResult> =
        Files.list(dir).use { s -> s.filter { it.fileName.toString().endsWith(".enc") }.toList() }
            .mapNotNull { get(it.fileName.toString().removeSuffix(".enc")) }
}
