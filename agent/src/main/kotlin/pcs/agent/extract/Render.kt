package pcs.agent.extract

import org.apache.pdfbox.Loader
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.rendering.ImageType
import org.apache.pdfbox.rendering.PDFRenderer
import java.awt.image.BufferedImage
import java.io.Closeable
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import javax.imageio.ImageIO

/** Renders pages to pixels, as a reader's viewer would (optional content off by default stays off). */
class PageRenderer(pdf: ByteArray) : Closeable {
    private val doc: PDDocument = Loader.loadPDF(pdf)
    private val renderer = PDFRenderer(doc).apply { isSubsamplingAllowed = false }
    private val cache = HashMap<Pair<Int, Float>, BufferedImage>()

    /** `page` is 1-based. */
    fun image(page: Int, scale: Float): BufferedImage = cache.getOrPut(page to scale) { renderer.renderImage(page - 1, scale, ImageType.RGB) }

    override fun close() = doc.close()
}

/** Recognizes the text in a rendered page. Behind an interface: tests use [ScriptedOcr]; real runs use [DockerOcr]. */
fun interface Ocr {
    /** `image` renders the page lazily: an engine that does not need pixels never pays for them. */
    fun recognize(page: Int, image: () -> BufferedImage): String

    companion object {
        const val SCALE = 3f
    }
}

/** Fixed text per page, for unit tests of the diff. */
class ScriptedOcr(private val pages: Map<Int, String>) : Ocr {
    override fun recognize(page: Int, image: () -> BufferedImage) = pages[page].orEmpty()
}

/**
 * Tesseract in a local container with no network (agent/ocr/Dockerfile). Pages go in and out
 * through a temporary directory; nothing leaves the machine.
 */
class DockerOcr(private val imageName: String = "pcs-ocr:latest", private val timeoutSeconds: Long = 120) : Ocr {
    override fun recognize(page: Int, image: () -> BufferedImage): String {
        val dir = Files.createTempDirectory("pcs-ocr")
        try {
            ImageIO.write(image(), "png", dir.resolve("page.png").toFile())
            val cmd = listOf("docker", "run", "--rm", "--network", "none", "-v", "$dir:/work", imageName, "/work/page.png", "stdout", "--psm", "4")
            val p = ProcessBuilder(cmd).redirectErrorStream(false).start()
            val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
            check(p.waitFor(timeoutSeconds, TimeUnit.SECONDS) && p.exitValue() == 0) {
                "OCR container failed: ${p.errorStream.readBytes().toString(Charsets.UTF_8).take(300)}"
            }
            return out
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    companion object {
        fun available(image: String = "pcs-ocr:latest"): Boolean =
            runCatching {
                val p = ProcessBuilder("docker", "image", "inspect", image).redirectErrorStream(true).start()
                p.inputStream.readBytes()
                p.waitFor(20, TimeUnit.SECONDS) && p.exitValue() == 0
            }.getOrDefault(false)
    }
}
