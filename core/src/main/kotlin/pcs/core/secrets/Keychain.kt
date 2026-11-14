package pcs.core.secrets

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

/** The two secrets of one conference, by keychain account name. */
public object Accounts {
    public fun token(conference: String): String = "$conference/hotcrp-token"

    public fun dbKey(conference: String): String = "$conference/db-key"
}

/** A fresh random DB key, for a conference whose store doesn't exist yet. */
public fun newDbKey(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
