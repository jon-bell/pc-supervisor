package pcs.runner

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.PrintStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ProxySelector
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.net.UnknownHostException
import java.net.spi.InetAddressResolverProvider
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/*
 * The boundary observer (PLAN §A6, §A5 T7): what leaves the test JVM, and what it writes. Four
 * parts: a proxy the JVM's HTTP clients and `core`'s client must use, which allows only the harness;
 * a resolver (a JDK name-service provider) that refuses and records every other host name; a
 * file-write monitor; and the canary scan, which looks for planted secrets in every byte and file.
 */

/** A planted secret and where it may legitimately appear. */
data class Canary(val name: String, val value: String, val allowedOnHarnessWire: Boolean, val allowedAuthorizationHeader: Boolean = false)

/** Faults in the observer itself (PLAN §A8 binding mutants); each is caught by a control. */
data class ObserverFaults(
    val missesSocket: Boolean = false,
    val missesFileWrite: Boolean = false,
    val missesCanary: Boolean = false,
)

data class WireEvent(
    val id: Int,
    val requestLine: String,
    val destination: String,
    val allowed: Boolean,
    val bytesOut: Long,
    val bytesIn: Long,
    val canaryHits: List<String>,
)

data class Violation(val kind: String, val detail: String)

/** Names the JDK resolver may resolve; everything else is refused and recorded (T7). */
object ResolverPolicy {
    val allowed: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet<String>().apply { add("localhost") }
    val refused: MutableList<String> = CopyOnWriteArrayList()
    val localHostName: String by lazy {
        runCatching { Files.readString(Path.of("/proc/sys/kernel/hostname")).trim() }.getOrNull()
            ?: System.getenv("HOSTNAME").orEmpty()
    }

    fun isAllowed(host: String): Boolean =
        host in allowed ||
            host.equals(localHostName, true) ||
            host.startsWith("127.") ||
            host == "::1" ||
            host.endsWith(".localhost") ||
            Regex("""[0-9.]+""").matches(host) &&
            host.startsWith("127.")
}

/** Loaded by the JDK through META-INF/services; present only on the runner's classpath, so only in test JVMs. */
class ObservingResolverProvider : InetAddressResolverProvider() {
    override fun get(configuration: Configuration): java.net.spi.InetAddressResolver {
        val builtin = configuration.builtinResolver()
        return object : java.net.spi.InetAddressResolver {
            override fun lookupByName(host: String, policy: java.net.spi.InetAddressResolver.LookupPolicy): java.util.stream.Stream<InetAddress> {
                if (!ResolverPolicy.isAllowed(host)) {
                    ResolverPolicy.refused += host
                    throw UnknownHostException("$host: refused by the boundary observer (only the harness may be resolved)")
                }
                return builtin.lookupByName(host, policy)
            }

            override fun lookupByAddress(addr: ByteArray): String = builtin.lookupByAddress(addr)
        }
    }

    override fun name(): String = "pcs-boundary-observer"
}

/** Finds canaries in a byte stream, across chunk boundaries. */
class StreamScanner(private val canaries: List<Canary>, private val faults: ObserverFaults) {
    private val buf = ByteArrayOutputStream()
    private var seen = 0L
    val hits: MutableSet<String> = linkedSetOf()

    fun feed(b: ByteArray, off: Int, len: Int) {
        // the mutant scans only the first bytes of each stream
        val take = if (faults.missesCanary) maxOf(0L, MUTANT_SCAN_LIMIT - seen).toInt().coerceAtMost(len) else len
        seen += len
        if (take > 0) buf.write(b, off, take)
    }

    fun finish(redactAuthorization: Boolean): Set<String> {
        var text = buf.toString(Charsets.ISO_8859_1)
        for (c in canaries) {
            val hay = if (redactAuthorization && c.allowedAuthorizationHeader) text.replace("Bearer ${c.value}", "Bearer <redacted>") else text
            if (hay.contains(c.value)) hits += c.name
        }
        text = ""
        return hits
    }

    companion object {
        const val MUTANT_SCAN_LIMIT = 16L
    }
}

class BoundaryObserver(
    private val harness: URI,
    val canaries: List<Canary>,
    val faults: ObserverFaults = ObserverFaults(),
) : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val frontUrl: URI = URI("http://127.0.0.1:${server.localPort}")
    private val harnessAuthority = "${harness.host}:${harness.port}"
    val events: MutableList<WireEvent> = CopyOnWriteArrayList()
    private val extra: MutableList<Violation> = CopyOnWriteArrayList()
    private var nextId = 0
    private val refusedBase = ResolverPolicy.refused.size

    @Volatile private var closed = false

    init {
        ResolverPolicy.allowed += harness.host
        thread(isDaemon = true, name = "pcs-observer") {
            while (!closed) {
                val c = runCatching { server.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { handle(c) } }
            }
        }
    }

    /** Make every proxy-aware client in this JVM go through the observer. Ktor's CIO client ignores this; `core` is given [frontUrl] instead. */
    fun installJvmWide() {
        val me = InetSocketAddress("127.0.0.1", server.localPort)
        ProxySelector.setDefault(
            object : ProxySelector() {
                override fun select(uri: URI?): List<java.net.Proxy> =
                    if (uri != null &&
                        uri.host == "127.0.0.1" &&
                        uri.port == server.localPort
                    ) {
                        listOf(java.net.Proxy.NO_PROXY)
                    } else {
                        listOf(java.net.Proxy(java.net.Proxy.Type.HTTP, me))
                    }

                override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: java.io.IOException?) = Unit
            },
        )
    }

    private fun handle(client: Socket) {
        client.use {
            val head = readHead(client.getInputStream()) ?: return
            val line = head.lineSequence().first()
            val parts = line.split(' ')
            val method = parts.getOrElse(0) { "" }
            val target = parts.getOrElse(1) { "" }
            val hostHeader = Regex("(?im)^host:\\s*(.+)$").find(head)?.groupValues?.get(1)?.trim().orEmpty()
            val dest =
                when {
                    method == "CONNECT" -> target
                    target.startsWith("http://") -> URI(target).let { "${it.host}:${if (it.port < 0) 80 else it.port}" }
                    hostHeader == "127.0.0.1:${server.localPort}" || hostHeader.isEmpty() -> harnessAuthority // origin-form: our own front, i.e. the harness
                    else -> hostHeader
                }
            val allowed = dest == harnessAuthority || dest == "localhost:${harness.port}"
            val id = synchronized(this) { nextId++ }
            val out = StreamScanner(canaries, faults)
            val inn = StreamScanner(canaries, faults)
            val headBytes = head.toByteArray(Charsets.ISO_8859_1)
            out.feed(headBytes, 0, headBytes.size)
            if (!allowed) {
                // refuse, after reading the body the client sent so the scan sees what it tried to send
                val len = Regex("(?im)^content-length:\\s*([0-9]+)").find(head)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val body = ByteArray(len.coerceAtMost(1 shl 20))
                runCatching { client.getInputStream().readNBytes(body, 0, body.size) }
                out.feed(body, 0, body.size)
                runCatching { client.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()) }
                record(id, line, dest, false, (headBytes.size + body.size).toLong(), 0, out.finish(false))
                return
            }
            val up = Socket(harness.host, harness.port)
            up.use {
                val upOut = up.getOutputStream()
                val rewritten =
                    if (target.startsWith("http://")) {
                        head.replaceFirst(
                            target,
                            URI(target).rawPath.ifEmpty { "/" } + (URI(target).rawQuery?.let { "?$it" } ?: ""),
                        )
                    } else {
                        head
                    }
                upOut.write(rewritten.toByteArray(Charsets.ISO_8859_1))
                val response = thread(isDaemon = true) { pipe(up.getInputStream(), client.getOutputStream(), inn) }
                var sent = headBytes.size.toLong()
                val request =
                    thread(isDaemon = true) {
                        sent += pipe(client.getInputStream(), upOut, out)
                        runCatching { up.shutdownOutput() }
                    }
                // the connection ends when the harness closes it (or, after the client closes, when it answers)
                response.join()
                runCatching { client.close() }
                request.join(2000)
                record(id, line, dest, true, sent, 0, out.finish(true) + inn.finish(false))
            }
        }
    }

    private fun record(id: Int, line: String, dest: String, allowed: Boolean, out: Long, inn: Long, hits: Set<String>) {
        // the mutant forgets every second connection
        if (faults.missesSocket && id % 2 == 1) return
        events += WireEvent(id, line, dest, allowed, out, inn, hits.toList())
    }

    private fun readHead(i: InputStream): String? {
        val b = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val c = i.read()
            if (c < 0) return if (b.size() == 0) null else b.toString(Charsets.ISO_8859_1)
            b.write(c)
            last4 = (last4 shl 8) or c
            if (last4 == 0x0d0a0d0a) return b.toString(Charsets.ISO_8859_1)
            if (b.size() > 1 shl 16) return null
        }
    }

    private fun pipe(from: InputStream, to: OutputStream, scan: StreamScanner): Long {
        var n = 0L
        val buf = ByteArray(8192)
        try {
            while (true) {
                val r = from.read(buf)
                if (r < 0) break
                scan.feed(buf, 0, r)
                to.write(buf, 0, r)
                to.flush()
                n += r
            }
        } catch (_: java.io.IOException) {
        }
        return n
    }

    fun violations(): List<Violation> {
        val byName = canaries.associateBy { it.name }
        val wire =
            events.filter { it.allowed }.flatMap { e ->
                e.canaryHits.filter { n -> byName.getValue(n).allowedOnHarnessWire.not() }.map { n -> Violation("canary-on-wire", "${e.requestLine}: $n") }
            }
        val denied = events.filter { !it.allowed }
        return denied.map { Violation("non-harness-destination", it.destination) } +
            denied.flatMap { e -> e.canaryHits.map { n -> Violation("canary-to-non-harness-host", "${e.destination}: $n") } } +
            wire +
            ResolverPolicy.refused.drop(refusedBase).distinct().map { Violation("refused-name-lookup", it) } +
            extra
    }

    fun addViolation(v: Violation) {
        extra += v
    }

    override fun close() {
        closed = true
        runCatching { server.close() }
    }
}

/** Notices files written during a run, and scans them for canaries (PLAN §A6). */
class FileWriteMonitor(private val roots: List<Path>, private val canaries: List<Canary>, private val faults: ObserverFaults = ObserverFaults()) {
    private data class Stamp(val size: Long, val mtime: Long)

    private var before: Map<Path, Stamp> = emptyMap()

    private fun snapshot(): Map<Path, Stamp> {
        val out = mutableMapOf<Path, Stamp>()
        for (root in roots) {
            if (!Files.exists(root)) continue
            // the mutant looks only at the top level of each root
            val depth = if (faults.missesFileWrite) 1 else Int.MAX_VALUE
            Files.walk(root, depth).use { s ->
                s.filter { Files.isRegularFile(it) }.forEach { out[it] = Stamp(Files.size(it), Files.getLastModifiedTime(it).toMillis()) }
            }
        }
        return out
    }

    fun start() {
        before = snapshot()
    }

    data class Finding(val path: Path, val canaries: List<String>)

    /** Files created or changed since [start]. */
    fun written(): List<Finding> {
        val now = snapshot()
        return now.filter { (p, s) -> before[p] != s }.map { (p, s) ->
            val hits =
                if (s.size >
                    MAX_SCAN
                ) {
                    emptyList()
                } else {
                    canaries.filter { c -> String(Files.readAllBytes(p), Charsets.ISO_8859_1).contains(c.value) }.map { it.name }
                }
            Finding(p, hits)
        }
    }

    companion object {
        const val MAX_SCAN = 8L shl 20
    }
}

/** Standard output, standard error, and `java.util.logging`, scanned for canaries (a planted log line is caught here). */
class LogCapture(private val canaries: List<Canary>) : AutoCloseable {
    private val buf = StringBuffer()
    private val oldOut = System.out
    private val oldErr = System.err
    private val handler =
        object : java.util.logging.Handler() {
            override fun publish(r: java.util.logging.LogRecord) {
                buf.append(r.message).append('\n')
            }

            override fun flush() = Unit

            override fun close() = Unit
        }

    private fun tee(old: PrintStream): PrintStream =
        PrintStream(
            object : OutputStream() {
                override fun write(b: Int) {
                    buf.append(b.toChar())
                    old.write(b)
                }
            },
            true,
        )

    fun start() {
        System.setOut(tee(oldOut))
        System.setErr(tee(oldErr))
        java.util.logging.Logger.getLogger("").addHandler(handler)
    }

    fun hits(): List<String> = buf.toString().let { text -> canaries.filter { text.contains(it.value) }.map { it.name } }

    override fun close() {
        System.setOut(oldOut)
        System.setErr(oldErr)
        java.util.logging.Logger.getLogger("").removeHandler(handler)
    }
}
