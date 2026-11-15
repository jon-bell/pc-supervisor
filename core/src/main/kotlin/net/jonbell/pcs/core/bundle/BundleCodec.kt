package net.jonbell.pcs.core.bundle

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.security.GeneralSecurityException
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.spec.NamedParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Why a bundle was not opened. The message never contains bundle content or the key. */
public class BundleException(public val reason: Reason, message: String) : IllegalArgumentException(message) {
    public enum class Reason { NOT_A_BUNDLE, WRONG_KEY_OR_TAMPERED, HASH_MISMATCH, BAD_KEY, UNSUPPORTED, NOT_A_RECIPIENT }
}

/**
 * A 256-bit AES key: the content key of one bundle (it never leaves the bundle except wrapped to a chair's public key) and the key of the
 * encrypted result store. [text] is one line of URL-safe base64.
 */
public class BundleKey private constructor(internal val bytes: ByteArray) {
    public val text: String get() = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    override fun toString(): String = "BundleKey(***)"

    /** AES-256-GCM with a fresh 12-byte nonce, [aad] authenticated: `nonce || ciphertext+tag`. */
    public fun seal(plain: ByteArray, aad: ByteArray): ByteArray {
        val nonce = ByteArray(NONCE).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(bytes, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return nonce + c.doFinal(plain)
    }

    /** The inverse of [seal], starting at [offset]; throws [GeneralSecurityException] for a wrong key, a changed byte or other [aad]. */
    public fun open(sealed: ByteArray, aad: ByteArray, offset: Int = 0): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(bytes, "AES"), GCMParameterSpec(128, sealed.copyOfRange(offset, offset + NONCE)))
        c.updateAAD(aad)
        return c.doFinal(sealed, offset + NONCE, sealed.size - offset - NONCE)
    }

    public companion object {
        private const val NONCE = 12

        internal fun of(bytes: ByteArray): BundleKey = BundleKey(bytes.copyOf())

        public fun generate(): BundleKey = BundleKey(ByteArray(32).also { SecureRandom().nextBytes(it) })

        public fun parse(text: String): BundleKey {
            val b = runCatching { Base64.getUrlDecoder().decode(text.trim()) }.getOrNull()
            if (b == null || b.size != 32) throw BundleException(BundleException.Reason.BAD_KEY, "a bundle key is 32 bytes as URL-safe base64")
            return BundleKey(b)
        }
    }
}

/** One recipient's copy of the content key: the chair's fingerprint, the ephemeral X25519 public key, and the key wrapped under the agreed secret. */
@Serializable
internal data class KeyWrap(val fp: String, val epk: String, val w: String)

/**
 * The file format (owner's ruling 2026-11-15: the content key is wrapped for each named chair, so no shared secret travels):
 *
 * ```
 * PCSBUNDLE2 <sha256 of the plaintext>\n
 * <JSON list of key wraps, one per chair>\n
 * <12-byte nonce> AES-256-GCM(content key, canonical payload, aad = the two lines above)
 * ```
 *
 * A wrap is ECIES: a fresh X25519 key agrees a secret with the chair's public key, HKDF-SHA256 turns it into a key-wrapping key,
 * and AES-256-GCM wraps the content key (header authenticated). The body's associated data is both lines, so removing or
 * editing a wrap is detected too. The hash in the header is the content address (and the file's name); it is recomputed after
 * decryption, so a file whose header was edited, or whose body was changed, is refused. Two chairs open the same file with their
 * own private keys; the content address does not depend on who it was sent to.
 */
public object BundleCodec {
    private const val MAGIC = "PCSBUNDLE2 "
    private const val NONCE = 12
    private val json = Json

    public fun fileName(hash: String): String = "bundle-$hash.pcsb"

    private fun wrapInfo(fp: String, epk: ByteArray) = ("pcs-bundle-wrap-v1\u0000$fp\u0000").toByteArray(Charsets.US_ASCII) + epk

    public fun encrypt(payload: BundlePayload, recipients: List<ChairPublicKey>): ByteArray {
        val to = recipients.distinct()
        require(to.isNotEmpty()) { "a bundle needs at least one chair's public key" }
        val plain = payload.bytes()
        val header = (MAGIC + sha256Hex(plain) + "\n").toByteArray(Charsets.US_ASCII)
        val content = BundleKey.generate()
        val wraps =
            to.map { r ->
                val eph = KeyPairGenerator.getInstance("X25519").also { it.initialize(NamedParameterSpec.X25519) }.generateKeyPair()
                val shared =
                    javax.crypto.KeyAgreement.getInstance("X25519").also {
                        it.init(eph.private)
                        it.doPhase(r.key, true)
                    }.generateSecret()
                val epk = eph.public.encoded
                val kek = BundleKey.of(Hkdf.derive(shared, header, wrapInfo(r.fingerprint, epk)))
                KeyWrap(r.fingerprint, b64(epk), b64(kek.seal(content.bytes, header)))
            }
        val wrapLine = (json.encodeToString(ListSerializer(KeyWrap.serializer()), wraps) + "\n").toByteArray(Charsets.US_ASCII)
        return header + wrapLine + content.seal(plain, header + wrapLine)
    }

    /** The content address in the header, without decrypting. Null if this is not a bundle. */
    public fun headerHash(file: ByteArray): String? =
        file.take(MAGIC.length + 65).toByteArray().toString(Charsets.US_ASCII).takeIf { it.startsWith(MAGIC) && it.endsWith("\n") }?.removePrefix(MAGIC)?.trim()
            ?.takeIf { it.matches(Regex("[0-9a-f]{64}")) }

    private fun wraps(file: ByteArray): Pair<List<KeyWrap>, Int> {
        val headerLen = MAGIC.length + 65
        val end =
            (headerLen until file.size).firstOrNull { file[it] == '\n'.code.toByte() }
                ?: throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "the bundle is truncated")
        val list =
            try {
                json.decodeFromString(ListSerializer(KeyWrap.serializer()), String(file, headerLen, end - headerLen, Charsets.US_ASCII))
            } catch (e: kotlinx.serialization.SerializationException) {
                throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "the bundle's recipient list is not understood")
            }
        return list to end + 1
    }

    /** The fingerprints of the chairs this bundle was made for, without decrypting. */
    public fun recipients(file: ByteArray): List<String> = if (headerHash(file) == null) emptyList() else wraps(file).first.map { it.fp }

    public fun decrypt(file: ByteArray, chair: ChairIdentity): BundlePayload {
        val hash = headerHash(file) ?: throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "not a screening bundle")
        val headerLen = MAGIC.length + 65
        if (file.size < headerLen + NONCE + 16) throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "the bundle is truncated")
        val (list, bodyStart) = wraps(file)
        val mine =
            list.firstOrNull { it.fp == chair.publicKey.fingerprint }
                ?: throw BundleException(
                    BundleException.Reason.NOT_A_RECIPIENT,
                    "this bundle was not made for your key (${chair.publicKey.fingerprint}); it is for ${list.joinToString {
                        it.fp
                    }}",
                )
        val header = file.copyOfRange(0, headerLen)
        val plain =
            try {
                val epkDer = java.util.Base64.getUrlDecoder().decode(mine.epk)
                val epk = java.security.KeyFactory.getInstance("X25519").generatePublic(X509EncodedKeySpec(epkDer))
                val kek = BundleKey.of(Hkdf.derive(chair.agree(epk), header, wrapInfo(mine.fp, epkDer)))
                val content = BundleKey.of(kek.open(java.util.Base64.getUrlDecoder().decode(mine.w), header))
                content.open(file, file.copyOfRange(0, bodyStart), bodyStart)
            } catch (e: GeneralSecurityException) {
                throw BundleException(
                    BundleException.Reason.WRONG_KEY_OR_TAMPERED,
                    "the bundle did not decrypt: the file was changed, or the key does not match",
                )
            } catch (e: IllegalArgumentException) {
                throw BundleException(
                    BundleException.Reason.WRONG_KEY_OR_TAMPERED,
                    "the bundle did not decrypt: the file was changed, or the key does not match",
                )
            }
        if (sha256Hex(plain) != hash) throw BundleException(BundleException.Reason.HASH_MISMATCH, "the bundle's content does not match its address")
        val p =
            try {
                BundlePayload.parse(plain)
            } catch (e: kotlinx.serialization.SerializationException) {
                throw BundleException(BundleException.Reason.UNSUPPORTED, "the bundle's content is not understood")
            }
        if (p.manifest.format !=
            BundleManifest.FORMAT
        ) {
            throw BundleException(BundleException.Reason.UNSUPPORTED, "unsupported bundle format ${p.manifest.format}")
        }
        return p
    }

    private fun b64(b: ByteArray) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
}
