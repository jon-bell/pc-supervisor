package net.jonbell.pcs.agent.engines

import java.net.URI

class EgressDenied(message: String) : RuntimeException(message)

/**
 * The only hosts a component may reach (agent.md §5.3). An engine's policy is exactly its configured
 * host; the reference resolver has a separate allowlist (`PCS_AGENT_EGRESS`) and the two never share
 * a host, so an engine cannot be used to reach an index and the resolver cannot carry paper text to an engine.
 * Matching is on the exact host: no subdomains, no userinfo tricks, no redirects followed by the callers.
 */
class EgressPolicy private constructor(val label: String, val allowedHosts: Set<String>, private val allowPlainHttp: Boolean) {
    /** Throws [EgressDenied] unless the request may go to [uri]. Plain HTTP only where the configuration itself said `http://`. */
    fun require(uri: URI) {
        val host = uri.host?.lowercase() ?: throw EgressDenied("$label: no host in $uri")
        if (uri.userInfo != null) throw EgressDenied("$label: credentials in a URL are not allowed")
        if (host !in allowedHosts) throw EgressDenied("$label: host '$host' is not on the allowlist ${allowedHosts.sorted()}")
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && !(scheme == "http" && allowPlainHttp)) throw EgressDenied("$label: scheme '$scheme' is not allowed for $host")
    }

    fun require(url: String) = require(URI.create(url))

    companion object {
        /** The reference resolver's public indexes: DOI resolution, Crossref, OpenAlex, arXiv. */
        val DEFAULT_RESOLVER_HOSTS = setOf("doi.org", "api.crossref.org", "api.openalex.org", "export.arxiv.org", "arxiv.org")

        fun forEngine(engineId: String, baseUrl: String): EgressPolicy {
            val u = URI.create(baseUrl)
            val host = u.host?.lowercase() ?: throw IllegalArgumentException("engine $engineId: no host in base URL")
            return EgressPolicy("engine $engineId", setOf(host), allowPlainHttp = u.scheme.equals("http", ignoreCase = true))
        }

        /** [allowlist] is the value of `PCS_AGENT_EGRESS`: comma-separated hosts; blank or null means [DEFAULT_RESOLVER_HOSTS]. */
        fun forResolver(allowlist: String?): EgressPolicy {
            val hosts =
                allowlist?.split(',')?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() }?.toSet()?.takeIf { it.isNotEmpty() } ?: DEFAULT_RESOLVER_HOSTS
            for (h in hosts) require(h.matches(Regex("[a-z0-9.-]+")) && '.' in h) { "PCS_AGENT_EGRESS: '$h' is not a plain host name" }
            return EgressPolicy("reference resolver", hosts, allowPlainHttp = false)
        }

        /** An engine host may not also be a resolver host. */
        fun assertDisjoint(engines: List<EgressPolicy>, resolver: EgressPolicy) {
            for (e in engines) {
                val both = e.allowedHosts.intersect(resolver.allowedHosts)
                require(both.isEmpty()) { "${e.label} and the reference resolver share host(s) $both" }
            }
        }
    }
}
