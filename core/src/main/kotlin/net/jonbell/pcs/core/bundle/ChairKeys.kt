package net.jonbell.pcs.core.bundle

import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.secrets.Keychain
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.NamedParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * A PC chair's public key (X25519, through the JDK). It is public: a chair sends it to whoever builds a bundle, by any channel.
 * [text] is one line, `pcs-chair-1:<URL-safe base64 of the X.509 encoding>`; [fingerprint] names it in a bundle's recipient list.
 */
public class ChairPublicKey internal constructor(internal val key: PublicKey) {
    private val encoded: ByteArray get() = key.encoded

    public val text: String get() = PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(encoded)

    /** The first 16 hex digits of SHA-256 of the encoding: enough to pick this chair's wrap out of the list, and to read aloud when comparing keys. */
    public val fingerprint: String get() = fingerprintOf(encoded)

    override fun equals(other: Any?): Boolean = other is ChairPublicKey && other.encoded.contentEquals(encoded)

    override fun hashCode(): Int = encoded.contentHashCode()

    override fun toString(): String = "ChairPublicKey($fingerprint)"

    public companion object {
        public const val PREFIX: String = "pcs-chair-1:"

        internal fun fingerprintOf(encoded: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(encoded).take(8).joinToString("") {
                "%02x".format(it)
            }

        public fun parse(text: String): ChairPublicKey {
            val t = text.trim()
            if (!t.startsWith(PREFIX)) throw BundleException(BundleException.Reason.BAD_KEY, "a chair public key starts with $PREFIX")
            val der = runCatching { Base64.getUrlDecoder().decode(t.removePrefix(PREFIX)) }.getOrNull()
            val key =
                try {
                    KeyFactory.getInstance("X25519").generatePublic(X509EncodedKeySpec(der ?: throw IllegalArgumentException()))
                } catch (e: Exception) {
                    throw BundleException(BundleException.Reason.BAD_KEY, "not a valid chair public key")
                }
            return ChairPublicKey(key)
        }

        /** Keys from a comma- or whitespace-separated list, each either a public key or the path of a file holding one or more (one per line, `#` comments). */
        public fun parseAll(spec: String, readFile: (String) -> String?): List<ChairPublicKey> {
            val out = mutableListOf<ChairPublicKey>()
            for (part in spec.split(',', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }) {
                if (part.startsWith(PREFIX)) {
                    out += parse(part)
                } else {
                    val body =
                        readFile(part) ?: throw BundleException(BundleException.Reason.BAD_KEY, "$part is neither a chair public key nor a readable file")
                    body.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.forEach { out += parse(it) }
                }
            }
            return out.distinct()
        }
    }
}

/** A chair's keypair. The private half lives in the OS keychain and is only read into memory to open a bundle; [toString] shows nothing secret. */
public class ChairIdentity internal constructor(private val priv: PrivateKey, public val publicKey: ChairPublicKey) {
    override fun toString(): String = "ChairIdentity(${publicKey.fingerprint})"

    /** The raw X25519 shared secret with [peer]. */
    internal fun agree(peer: PublicKey): ByteArray =
        KeyAgreement.getInstance("X25519").also {
            it.init(priv)
            it.doPhase(peer, true)
        }.generateSecret()

    /** What the keychain keeps: `v1.<PKCS#8>.<X.509>`, URL-safe base64. */
    internal fun stored(): String =
        "v1." + Base64.getUrlEncoder().withoutPadding().encodeToString(priv.encoded) + "." +
            Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey.key.encoded)

    public companion object {
        public fun generate(): ChairIdentity = of(KeyPairGenerator.getInstance("X25519").also { it.initialize(NamedParameterSpec.X25519) }.generateKeyPair())

        internal fun of(p: KeyPair) = ChairIdentity(p.private, ChairPublicKey(p.public))

        internal fun fromStored(s: String): ChairIdentity {
            val parts = s.trim().split('.')
            require(parts.size == 3 && parts[0] == "v1") { "the stored chair key is not in a known format" }
            val kf = KeyFactory.getInstance("X25519")
            val d = Base64.getUrlDecoder()
            return ChairIdentity(
                kf.generatePrivate(PKCS8EncodedKeySpec(d.decode(parts[1]))),
                ChairPublicKey(kf.generatePublic(X509EncodedKeySpec(d.decode(parts[2])))),
            )
        }
    }
}

/** One chair's identity in the OS keychain, under `<conference>/chair-key` (the existing keychain layer). Created on first use. */
public object ChairKeychain {
    public fun load(keychain: Keychain, conference: String): ChairIdentity? =
        keychain.read(Accounts.chairKey(conference))?.let {
            try {
                ChairIdentity.fromStored(it)
            } catch (e: IllegalArgumentException) {
                null
            }
        }

    public fun loadOrCreate(keychain: Keychain, conference: String): ChairIdentity =
        load(keychain, conference) ?: ChairIdentity.generate().also { keychain.write(Accounts.chairKey(conference), it.stored()) }
}

/** HKDF-SHA256 (RFC 5869), one output block: enough for a 256-bit key-wrapping key. */
internal object Hkdf {
    fun derive(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").also { it.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256")) }
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256").also { it.init(SecretKeySpec(prk, "HmacSHA256")) }
        expand.update(info)
        expand.update(1)
        return expand.doFinal()
    }
}
