package pcs.runner

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.Socket
import java.net.URI
import java.nio.file.Files

/*
 * Binding controls (PLAN §A8). A positive control shows a binding sees what is known to be there;
 * a negative control switches a binding mutant on and shows the same scenario then disagrees with
 * the model. A control's evidence is the run itself, so `check-evidence` re-derives whether it
 * passed or caught the mutant, without trusting the test that ran it.
 */
object Controls {
    fun traceControl(name: String, polarity: String, binding: String, mutant: String?, record: JsonObject, caught: Boolean): JsonObject =
        buildJsonObject {
            put("name", name)
            put("polarity", polarity)
            put("binding", binding)
            put("mutant", mutant ?: "")
            put("caught", caught)
            put("trace", record)
        }

    fun observerControl(name: String, polarity: String, mutant: String?, planted: List<String>, seen: List<String>): JsonObject =
        buildJsonObject {
            put("name", name)
            put("polarity", polarity)
            put("binding", "boundary-observer")
            put("mutant", mutant ?: "")
            put("caught", planted.any { it !in seen })
            put(
                "observer",
                buildJsonObject {
                    put("planted", JsonArray(planted.map { JsonPrimitive(it) }))
                    put("seen", JsonArray(seen.map { JsonPrimitive(it) }))
                },
            )
        }

    /** Sends a raw HTTP request to the observer's front, one socket each, so the observer must see each socket. */
    private fun rawRequest(front: URI, line: String, extra: String = "", body: String = ""): String =
        Socket(InetAddress.getLoopbackAddress(), front.port).use { s ->
            val w = OutputStreamWriter(s.getOutputStream(), Charsets.ISO_8859_1)
            w.write(
                "$line\r\nHost: ${front.host}:${front.port}\r\n$extra" + (if (body.isNotEmpty()) "Content-Length: ${body.length}\r\n" else "") +
                    "Connection: close\r\n\r\n$body",
            )
            w.flush()
            runCatching { s.getInputStream().readAllBytes().toString(Charsets.ISO_8859_1) }.getOrDefault("")
        }

    /** The observer must see every socket opened to the harness (and its request line). */
    fun socketControl(harness: URI, token: String, faults: ObserverFaults): JsonObject {
        BoundaryObserver(harness, emptyList(), faults).use { o ->
            val planted = (0 until 4).map { "GET /api/whoami?pretty=0&n=$it HTTP/1.1" }
            planted.forEach { rawRequest(o.frontUrl, it, "Authorization: Bearer $token\r\n") }
            Thread.sleep(300)
            return observerControl(
                if (faults.missesSocket) "observer misses a socket" else "observer sees every socket to the harness",
                if (faults.missesSocket) "negative" else "positive",
                if (faults.missesSocket) "observer-misses-socket" else null,
                planted,
                o.events.map { it.requestLine },
            )
        }
    }

    /** The monitor must see every file written under its roots, including nested ones. */
    fun fileControl(faults: ObserverFaults): JsonObject {
        val root = Files.createTempDirectory("pcs-filemon")
        val mon = FileWriteMonitor(listOf(root), emptyList(), faults)
        mon.start()
        val planted = listOf("a.txt", "sub/b.txt", "sub/deep/c.txt")
        planted.forEach {
            val f = root.resolve(it)
            Files.createDirectories(f.parent)
            Files.writeString(f, "planted $it")
        }
        val seen = mon.written().map { root.relativize(it.path).toString() }
        root.toFile().deleteRecursively()
        return observerControl(
            if (faults.missesFileWrite) "observer misses a file write" else "observer sees every file written",
            if (faults.missesFileWrite) "negative" else "positive",
            if (faults.missesFileWrite) "observer-misses-file-write" else null,
            planted,
            seen,
        )
    }

    /** A canary in the middle of a request body must be found. */
    fun canaryControl(harness: URI, faults: ObserverFaults): JsonObject {
        val canary = Canary("planted-canary", "CANARY-PLANTED-0042", allowedOnHarnessWire = false)
        BoundaryObserver(harness, listOf(canary), faults).use { o ->
            rawRequest(o.frontUrl, "POST /api/whoami?pretty=0 HTTP/1.1", body = "x".repeat(64) + canary.value + "y".repeat(64))
            Thread.sleep(300)
            return observerControl(
                if (faults.missesCanary) "observer misses a canary" else "observer finds a planted canary",
                if (faults.missesCanary) "negative" else "positive",
                if (faults.missesCanary) "observer-misses-canary" else null,
                listOf("canary:${canary.name}"),
                o.events.flatMap { it.canaryHits }.map { "canary:$it" },
            )
        }
    }

    fun observerControls(harness: URI, token: String): List<JsonObject> =
        listOf(
            socketControl(harness, token, ObserverFaults()),
            socketControl(harness, token, ObserverFaults(missesSocket = true)),
            fileControl(ObserverFaults()),
            fileControl(ObserverFaults(missesFileWrite = true)),
            canaryControl(harness, ObserverFaults()),
            canaryControl(harness, ObserverFaults(missesCanary = true)),
        )
}
