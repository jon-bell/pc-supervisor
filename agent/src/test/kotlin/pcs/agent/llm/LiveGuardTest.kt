package pcs.agent.llm

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.agent.engines.Adapter
import pcs.agent.engines.ClaudeCodeEngine
import pcs.agent.engines.DataClass
import pcs.agent.engines.Dispatcher
import pcs.agent.engines.LiveCallBlocked
import pcs.agent.engines.LiveGuard
import pcs.agent.engines.Registered
import pcs.agent.engines.cfg
import pcs.agent.engines.request
import pcs.testing.Covers
import java.nio.file.Files
import java.nio.file.Path

/** Tests and CI make zero live calls: reaching the real `claude` binary fails the test (an Error, so no catch-all hides it). */
@Covers("prop:S5")
class LiveGuardTest {
    @Test
    fun `reaching the real claude binary in a test fails the test before any process starts`() {
        assertTrue(LiveGuard.blocked(), "the test task sets pcs.noLive")
        val c = cfg("dev", Adapter.CLAUDE_CODE, DataClass.PUBLIC, model = "haiku", baseUrl = null)
        val d = Dispatcher(listOf(Registered(c, ClaudeCodeEngine(c))))
        val e = assertThrows(LiveCallBlocked::class.java) { runBlocking { d.call("dev", request(DataClass.SYNTHETIC)) } }
        assertTrue(e.message!!.contains("tests use replay only"))
    }

    @Test
    fun `a command given as a path is a fake and is not blocked`(
        @TempDir tmp: Path,
    ) {
        val marker = tmp.resolve("ran")
        val script = tmp.resolve("claude")
        Files.writeString(
            script,
            "#!/bin/sh\ntouch '$marker'\necho '{\"type\":\"result\",\"is_error\":false,\"structured_output\":{\"summary\":\"s\",\"notes\":[]}}'\n",
        )
        script.toFile().setExecutable(true)
        val c = cfg("dev", Adapter.CLAUDE_CODE, DataClass.PUBLIC, model = "haiku", baseUrl = null, command = script.toString())
        val d = Dispatcher(listOf(Registered(c, ClaudeCodeEngine(c))))
        val r = runBlocking { d.call("dev", request(DataClass.SYNTHETIC)) }
        assertEquals(pcs.agent.engines.Status.OK, r.result.status)
        assertTrue(Files.exists(marker))
    }
}
