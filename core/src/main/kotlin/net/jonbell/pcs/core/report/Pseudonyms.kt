package net.jonbell.pcs.core.report

import java.nio.file.Files
import java.nio.file.Path
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Keyed pseudonyms (spec §10.4 G, concepts `prop:C3`): HMAC-SHA256 of the lower-cased email under the chair-held key, cut to 128 bits.
 * The same key gives the same pseudonym, so rows join across exports; a different key gives an unrelated one. Papers and people use
 * different domains, so a paper number never collides with a person.
 */
public class Pseudonyms(key: ByteArray) {
    init {
        require(key.size >= MIN_KEY_BYTES) { "the pseudonym key must be at least $MIN_KEY_BYTES bytes" }
    }

    private val spec = SecretKeySpec(key, "HmacSHA256")

    private fun mac(domain: String, value: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(spec)
        return m.doFinal("$domain:$value".toByteArray(Charsets.UTF_8)).take(16).joinToString("") { "%02x".format(it) }
    }

    public fun person(email: String): String = "u-" + mac("person", email.trim().lowercase())

    public fun paper(pid: Long): String = "p-" + mac("paper", pid.toString())

    public companion object {
        public const val MIN_KEY_BYTES: Int = 16

        /** The key from `PCS_PSEUDONYM_KEY`, else the first line of the file `PCS_PSEUDONYM_KEY_FILE` names; null when neither is set. */
        public fun resolve(settings: Map<String, String>): Pseudonyms? {
            val inline = settings["PCS_PSEUDONYM_KEY"]?.takeIf { it.isNotBlank() }
            val file = settings["PCS_PSEUDONYM_KEY_FILE"]?.takeIf { it.isNotBlank() }
            val text = inline ?: file?.let { Files.readAllLines(Path.of(it)).firstOrNull { l -> l.isNotBlank() } }?.trim() ?: return null
            return Pseudonyms(text.toByteArray(Charsets.UTF_8))
        }
    }
}
