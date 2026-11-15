package net.jonbell.pcs.core.secrets

import com.github.javakeyring.BackendNotSupportedException
import com.github.javakeyring.Keyring
import com.github.javakeyring.PasswordAccessException
import java.security.SecureRandom
import java.util.Base64

/**
 * Where the API token and the DB key live (spec §4.1, AGENTS.md non-negotiable 5). The UI never
 * sees either: it asks [Secrets] for a session, and `core` reads the keychain itself.
 */
public interface Keychain {
    /** A one-line description of the backend, for the unlock screen. Never a secret. */
    public val backend: String

    /** The secret stored under [account], or null if there is none. Throws [KeychainException] if the keychain can't be read. */
    public fun read(account: String): String?

    public fun write(account: String, secret: String)
}

/** The keychain is missing, locked, or refused us. The message never contains a secret. */
public class KeychainException(message: String) : IllegalStateException(message)

/** The OS keychain through java-keyring: macOS Keychain, Windows Credential Manager, or libsecret. */
public class OsKeychain(private val service: String = SERVICE) : Keychain {
    private val keyring: Keyring =
        try {
            Keyring.create()
        } catch (e: BackendNotSupportedException) {
            throw KeychainException("no OS keychain is available on this machine (${e.javaClass.simpleName})")
        }

    override val backend: String get() = "OS keychain (${keyring.keyringStorageType})"

    override fun read(account: String): String? =
        try {
            keyring.getPassword(service, account)
        } catch (e: PasswordAccessException) {
            null
        }

    override fun write(account: String, secret: String) {
        try {
            keyring.setPassword(service, account, secret)
        } catch (e: PasswordAccessException) {
            throw KeychainException("the OS keychain refused to store $account")
        }
    }

    public companion object {
        public const val SERVICE: String = "pc-supervisor"
    }
}

/** The secrets of one conference, by keychain account name. */
public object Accounts {
    public fun token(conference: String): String = "$conference/hotcrp-token"

    public fun dbKey(conference: String): String = "$conference/db-key"

    /** The chair's own X25519 keypair for screening bundles (the private half; the public half is shown and exported). */
    public fun chairKey(conference: String): String = "$conference/chair-key"
}

/** A fresh random DB key, for a conference whose store doesn't exist yet. */
public fun newDbKey(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

/**
 * A keychain in one owner-only file, for headless runs against the local harness (`PCS_KEYCHAIN_FILE`, honoured only for a localhost instance,
 * like `PCS_DB_KEY`). A real instance's secrets stay in the OS keychain.
 */
public class FileKeychain(private val path: java.nio.file.Path) : Keychain {
    override val backend: String get() = "file keychain $path (local harness only)"

    private fun load(): MutableMap<String, String> =
        if (java.nio.file.Files.isRegularFile(path)) {
            java.nio.file.Files.readAllLines(path).filter { '\t' in it }.associateTo(linkedMapOf()) { it.substringBefore('\t') to it.substringAfter('\t') }
        } else {
            linkedMapOf()
        }

    override fun read(account: String): String? = load()[account]

    override fun write(account: String, secret: String) {
        val m = load().also { it[account] = secret }
        path.toAbsolutePath().parent?.let { java.nio.file.Files.createDirectories(it) }
        java.nio.file.Files.writeString(path, m.entries.joinToString("\n", postfix = "\n") { "${it.key}\t${it.value}" })
        runCatching { java.nio.file.Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")) }
    }
}
