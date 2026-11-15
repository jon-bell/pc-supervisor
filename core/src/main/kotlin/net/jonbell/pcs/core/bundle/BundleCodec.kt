package net.jonbell.pcs.core.bundle

import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Why a bundle was not opened. The message never contains bundle content or the key. */
public class BundleException(public val reason: Reason, message: String) : IllegalArgumentException(message) {
    public enum class Reason { NOT_A_BUNDLE, WRONG_KEY_OR_TAMPERED, HASH_MISMATCH, BAD_KEY, UNSUPPORTED }
}

/** The 256-bit key of one bundle. It travels separately from the file (spec §11); [text] is one line of URL-safe base64. */
public class BundleKey private constructor(internal val bytes: ByteArray) {
    public val text: String get() = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    override fun toString(): String = "BundleKey(***)"

    public companion object {
        public fun generate(): BundleKey = BundleKey(ByteArray(32).also { SecureRandom().nextBytes(it) })

        public fun parse(text: String): BundleKey {
            val b = runCatching { Base64.getUrlDecoder().decode(text.trim()) }.getOrNull()
            if (b == null || b.size != 32) throw BundleException(BundleException.Reason.BAD_KEY, "a bundle key is 32 bytes as URL-safe base64")
            return BundleKey(b)
        }
    }
}

/**
 * The file format: `PCSBUNDLE1 <sha256 of the plaintext>\n`, a 12-byte nonce, then AES-256-GCM of the
 * canonical payload with the header line as associated data. The hash in the header is the content
 * address (and the file's name); it is recomputed after decryption, so a file whose header was edited,
 * or whose body was changed, is refused.
 */
public object BundleCodec {
    private const val MAGIC = "PCSBUNDLE1 "
    private const val NONCE = 12

    public fun fileName(hash: String): String = "bundle-$hash.pcsb"

    public fun encrypt(payload: BundlePayload, key: BundleKey): ByteArray {
        val plain = payload.bytes()
        val header = (MAGIC + sha256Hex(plain) + "\n").toByteArray(Charsets.US_ASCII)
        val nonce = ByteArray(NONCE).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key.bytes, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(header)
        return header + nonce + c.doFinal(plain)
    }

    /** The content address in the header, without decrypting. Null if this is not a bundle. */
    public fun headerHash(file: ByteArray): String? =
        file.take(MAGIC.length + 65).toByteArray().toString(Charsets.US_ASCII).takeIf { it.startsWith(MAGIC) && it.endsWith("\n") }?.removePrefix(MAGIC)?.trim()
            ?.takeIf { it.matches(Regex("[0-9a-f]{64}")) }

    public fun decrypt(file: ByteArray, key: BundleKey): BundlePayload {
        val hash = headerHash(file) ?: throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "not a screening bundle")
        val headerLen = MAGIC.length + 65
        if (file.size < headerLen + NONCE + 16) throw BundleException(BundleException.Reason.NOT_A_BUNDLE, "the bundle is truncated")
        val plain =
            try {
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key.bytes, "AES"), GCMParameterSpec(128, file.copyOfRange(headerLen, headerLen + NONCE)))
                c.updateAAD(file, 0, headerLen)
                c.doFinal(file, headerLen + NONCE, file.size - headerLen - NONCE)
            } catch (e: GeneralSecurityException) {
                throw BundleException(BundleException.Reason.WRONG_KEY_OR_TAMPERED, "the bundle did not decrypt: wrong key, or the file was changed")
            }
        if (sha256Hex(plain) != hash) throw BundleException(BundleException.Reason.HASH_MISMATCH, "the bundle's content does not match its address")
        val p =
            try {
                BundlePayload.parse(plain)
            } catch (e: kotlinx.serialization.SerializationException) {
                throw BundleException(BundleException.Reason.UNSUPPORTED, "the bundle's content is not understood")
            }
        if (p.manifest.format != BundleManifest.FORMAT) throw BundleException(BundleException.Reason.UNSUPPORTED, "unsupported bundle format ${p.manifest.format}")
        return p
    }
}
