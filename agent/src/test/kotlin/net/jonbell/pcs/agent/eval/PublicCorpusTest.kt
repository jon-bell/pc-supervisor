@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.eval

import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/** The `public` corpus: manifest format, license rule, checksums, and the dev/held-out split. No PDF is downloaded and nothing opens a connection. */
@Covers("prop:S4")
class PublicCorpusTest {
    private val manifest = Path.of(System.getProperty("pcs.repoRoot"), "agent/corpora/public/manifest.json")
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")

    @Test
    fun `the shipped manifest is valid, all placeholders, and loads nothing`() {
        val m = PublicCorpus.parse(Files.readString(manifest))
        assertEquals(emptyList<String>(), PublicCorpus.validate(m))
        assertTrue(m.entries.all { it.placeholder && it.sha256 == null })
        assertTrue(m.entries.any { it.split == "dev" } && m.entries.any { it.split == "held-out" })
        val loaded = PublicCorpus.load(manifest, null)
        assertTrue(loaded.all { it.status == PublicStatus.PLACEHOLDER })
        assertTrue(PublicCorpus.usable(loaded, "dev").isEmpty() && PublicCorpus.usable(loaded, "held-out").isEmpty())
    }

    @Test
    fun `stand-ins load with their checksums, the split is kept, and a changed file is caught and never re-pinned`(
        @TempDir tmp: Path,
    ) {
        val written = PublicCorpus.writeStandIns(tmp, count = 4)
        val m = tmp.resolve("manifest.json")
        val loaded = PublicCorpus.load(m, tmp)
        assertTrue(loaded.all { it.status == PublicStatus.OK })
        assertEquals(2, PublicCorpus.usable(loaded, "dev").size)
        assertEquals(2, PublicCorpus.devEntries(loaded).size)
        assertTrue(PublicCorpus.devEntries(loaded).none { it.entry.split == "held-out" }, "prompt development cannot see held-out entries")
        assertEquals(written.entries.map { it.sha256 }, loaded.map { it.actualSha })
        // The same bytes re-render to the same manifest.
        assertEquals(PublicCorpus.render(PublicCorpus.parse(Files.readString(m))), Files.readString(m))

        Files.write(tmp.resolve("standin-01.pdf"), byteArrayOf(1, 2, 3))
        val after = PublicCorpus.load(m, tmp)
        assertEquals(PublicStatus.CHECKSUM_MISMATCH, after.first { it.entry.id == "standin-01" }.status)
        assertTrue(PublicCorpus.usable(after, "dev").none { it.entry.id == "standin-01" })
        assertThrows(PublicCorpusException::class.java) { PublicCorpus.pin(m, tmp) }
    }

    @Test
    fun `pin fills in the checksum of a fetched file and leaves the others`(
        @TempDir tmp: Path,
    ) {
        val src = PublicCorpus.writeStandIns(tmp.resolve("full"), count = 2)
        val dir = tmp.resolve("fetched").also { Files.createDirectories(it) }
        Files.copy(tmp.resolve("full/standin-01.pdf"), dir.resolve("standin-01.pdf"))
        val m = tmp.resolve("manifest.json")
        Files.writeString(m, PublicCorpus.render(src.copy(entries = src.entries.map { it.copy(sha256 = null) })))
        assertEquals(setOf(PublicStatus.UNPINNED, PublicStatus.NOT_FETCHED), PublicCorpus.load(m, dir).map { it.status }.toSet())
        val pinned = PublicCorpus.pin(m, dir)
        assertEquals(src.entries[0].sha256, pinned.entries[0].sha256)
        assertEquals(null, pinned.entries[1].sha256)
    }

    @Test
    fun `a manifest with a bad license, source, split, duplicate or checksum is refused with every problem`() {
        fun e(
            id: String,
            source: PublicSource = PublicSource(doi = "10.9999/x.1"),
            license: String = "CC-BY-4.0",
            split: String = "dev",
            sha: String? = null,
        ) = PublicEntry(id, source, "t", license, split, sha256 = sha)
        val m =
            PublicManifest(
                1,
                "",
                listOf(
                    e("a", license = "arXiv-default"),
                    e("b", source = PublicSource()),
                    e("c", source = PublicSource(doi = "10.9999/x", arxiv = "2101.00001")),
                    e("d", source = PublicSource(doi = "not-a-doi")),
                    e("e", source = PublicSource(arxiv = "nope")),
                    e("f", split = "test"),
                    e("g", sha = "xyz"),
                    e("g"),
                ),
            )
        val problems = PublicCorpus.validate(m)
        for (needle in listOf(
            "a: license",
            "b: give exactly one",
            "c: give exactly one",
            "d: not a DOI",
            "e: not an arXiv id",
            "f: split",
            "g: sha256",
            "duplicate",
        )) {
            assertTrue(problems.any { needle in it }, "$needle in $problems")
        }
        assertEquals(
            emptyList<String>(),
            PublicCorpus.validate(PublicManifest(1, "", listOf(e("ok", source = PublicSource(arxiv = "2101.00001v2"), sha = "0".repeat(64))))),
        )
    }

    @Test
    fun `the cli validates, writes stand-ins and pins`(
        @TempDir tmp: Path,
    ) {
        val sb = StringBuilder()
        val cli = ShootoutCli(emptyMap(), sb, agentDir)
        assertEquals(0, cli.corpus(listOf("validate", manifest.toString())))
        assertTrue("PLACEHOLDER" in sb && "usable: dev 0, held-out 0" in sb)
        assertEquals(0, cli.corpus(listOf("standins", tmp.toString())))
        assertEquals(0, cli.corpus(listOf("validate", tmp.resolve("manifest.json").toString(), tmp.toString())))
        assertTrue("usable: dev 2, held-out 2" in sb)
        assertEquals(2, cli.corpus(listOf("bogus")))
    }
}
