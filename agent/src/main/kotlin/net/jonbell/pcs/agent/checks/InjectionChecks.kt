package net.jonbell.pcs.agent.checks

import net.jonbell.pcs.core.rules.Ground

/** `injection.hidden` (agent.md §3.2). Hidden text is a signal; hidden text addressed to an AI reader is evidence for `prompt-injection`. */
object InjectionHiddenCheck : Check {
    override val id = "injection.hidden"

    override fun run(ctx: ScreenContext): List<Finding> =
        ctx.hidden.spans.map { s ->
            val hits = HiddenDetector.payloads(s).flatMap { AddressedPatterns.scan(it) }
            val addressed = hits.isNotEmpty()
            val anchor =
                if (s.channel != null) {
                    Anchor(s.page, s.channel, s.start, s.end)
                } else {
                    Anchor(s.page, null, s.start, s.end, s.region)
                }
            ctx.finding(
                id,
                if (addressed) Ground.PROMPT_INJECTION else null,
                if (addressed) Severity.HIGH else Severity.MEDIUM,
                s.vectors,
                if (addressed) {
                    "Text a reader cannot see and that addresses an AI reader (${hits.map { it.pattern.category }.distinct().joinToString()})"
                } else {
                    "Text in the text layer that a reader cannot see"
                },
                s.text,
                anchor,
                detail = s.decoded?.let { "decodes to: $it" },
            )
        }
}

/**
 * `injection.channels` (agent.md §3.2): text outside the page content that a tool might hand to a
 * model. Text that addresses an AI reader is evidence for `prompt-injection`. Scripts, embedded
 * files, annotations and form values are signals on their own: an anonymous submission has no
 * reason to carry them. Metadata and bookmarks are flagged only when they address an AI reader,
 * so a tool's ordinary Producer and Title do not fire.
 */
object InjectionChannelsCheck : Check {
    override val id = "injection.channels"

    private val structural = listOf("js:", "embedded:", "annot-file:", "annot:", "form:")

    override fun run(ctx: ScreenContext): List<Finding> =
        ctx.x.channels.filterNot { it.key.startsWith("actualtext:") || it.key.startsWith("alt:") }.mapNotNull { c ->
            val hits = AddressedPatterns.scan(c.text)
            val isStructural = structural.any { c.key.startsWith(it) }
            val anchor: (Int, Int) -> Anchor = { s, e -> Anchor(c.page, c.key, s, e) }
            when {
                hits.isNotEmpty() -> {
                    val h = hits.first()
                    ctx.finding(
                        id,
                        Ground.PROMPT_INJECTION,
                        Severity.HIGH,
                        listOf(vectorOf(c.key)),
                        "Text in ${c.key} that addresses an AI reader (${hits.map { it.pattern.category }.distinct().joinToString()})",
                        c.text.substring(h.start, h.endExclusive),
                        anchor(h.start, h.endExclusive),
                    )
                }
                isStructural -> {
                    val e = minOf(c.text.length, 200)
                    ctx.finding(
                        id,
                        null,
                        Severity.MEDIUM,
                        listOf(vectorOf(c.key)),
                        "Content in ${c.key}, a channel a reader does not see",
                        c.text.substring(0, e),
                        anchor(0, e),
                    )
                }
                else -> null
            }
        }

    fun vectorOf(key: String): String =
        when {
            key.startsWith("info:") -> "doc-info"
            key == "xmp" -> "xmp"
            key.startsWith("annot-file:") -> "embedded-file"
            key.startsWith("annot:") -> "annotation"
            key.startsWith("form:") -> "form-field"
            key.startsWith("bookmark:") -> "bookmark"
            key.startsWith("embedded:") -> "embedded-file"
            key.startsWith("js:") -> "javascript"
            else -> key.substringBefore(':')
        }
}

/**
 * The pattern half of `injection.addressed` (agent.md §3.2) over visible page text. A visible
 * match is a signal for a person and never a ground by itself; in a paper about LLMs or prompt
 * injection, where quoting payloads is expected, it is a LOW signal. Hidden spans are reported by
 * `injection.hidden` (with the ground), so they are not repeated here.
 */
object InjectionAddressedCheck : Check {
    override val id = "injection.addressed"

    override fun run(ctx: ScreenContext): List<Finding> {
        val about = AddressedPatterns.aboutLlms(ctx.x.pages.joinToString("\n") { it.text })
        return ctx.x.pages.flatMap { p ->
            AddressedPatterns.scan(p.text).filterNot { ctx.hidden.overlaps(p.page, it.start, it.endExclusive) }.map { m ->
                ctx.finding(
                    id,
                    null,
                    if (about) Severity.LOW else Severity.MEDIUM,
                    listOf("visible", m.pattern.category),
                    if (about) {
                        "Visible text that matches an instruction pattern, in a paper about LLMs (${m.pattern.id}); a person decides whether it is a quotation"
                    } else {
                        "Visible text that addresses an AI reader (${m.pattern.id})"
                    },
                    p.text.substring(m.start, m.endExclusive),
                    Anchor(p.page, null, m.start, m.endExclusive, p.regionOf(m.start, m.endExclusive)),
                )
            }
        }
    }
}
