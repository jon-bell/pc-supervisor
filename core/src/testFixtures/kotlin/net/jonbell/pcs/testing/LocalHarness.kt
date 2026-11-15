package net.jonbell.pcs.testing

import net.jonbell.pcs.core.config.Settings
import java.net.URI

/**
 * The guard every test helper runs before it talks to HotCRP (AGENTS.md non-negotiable 2, `prop:H4`):
 * only the disposable harness on this machine. The check is on the parsed host, so a URL like
 * `http://127.0.0.1.example.org` or `http://user@evil.example/` does not pass.
 */
public object LocalHarness {
    public fun require(url: String): URI {
        val u =
            try {
                URI(url)
            } catch (e: java.net.URISyntaxException) {
                throw IllegalStateException("refusing to run tests against an unparseable HotCRP URL", e)
            }
        return require(u)
    }

    public fun require(u: URI): URI {
        check((u.scheme == "http" || u.scheme == "https") && u.userInfo == null && Settings.isLocalhost(u)) {
            "refusing to run tests against a non-harness HotCRP: ${u.host}"
        }
        return u
    }
}
