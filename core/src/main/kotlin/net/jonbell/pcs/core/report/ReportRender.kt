package net.jonbell.pcs.core.report

import net.jonbell.pcs.core.session.Session

/** The report as Markdown or HTML (spec §10.4 G). Both are a function of the report alone: deterministic, no clock. */
public object ReportRender {
    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private fun md(s: String) = s.replace("|", "\\|").replace("\n", " ")

    public fun markdown(r: ProcessReport): String =
        buildString {
            appendLine("# Process report")
            appendLine()
            appendLine("As of ${r.asOf ?: "no sync yet"}; computed at ${r.now}. Counts, timings and rule outcomes only: no names, titles or review text.")
            for (s in r.sections) {
                appendLine()
                appendLine("## ${s.title}")
                appendLine()
                if (!s.available) appendLine("Not available: ${s.note}") else s.note?.let { appendLine("Note: $it") }
                for (t in s.tables) {
                    appendLine()
                    appendLine("**${md(t.title)}**")
                    appendLine()
                    appendLine(t.header.joinToString(" | ", "| ", " |") { md(it) })
                    appendLine(t.header.joinToString(" | ", "| ", " |") { "---" })
                    if (t.rows.isEmpty()) appendLine("| " + (listOf("none") + List(t.header.size - 1) { "" }).joinToString(" | ") + " |")
                    for (row in t.rows) appendLine(row.joinToString(" | ", "| ", " |") { md(it) })
                }
            }
        }

    public fun html(r: ProcessReport): String =
        buildString {
            appendLine("<!doctype html><html><head><meta charset=\"utf-8\"><title>Process report</title>")
            appendLine(
                "<style>body{font-family:sans-serif;max-width:60em;margin:2em auto}table{border-collapse:collapse;margin:.5em 0}td,th{border:1px solid #bbb;padding:.2em .6em;text-align:left}</style>",
            )
            appendLine("</head><body><h1>Process report</h1>")
            appendLine(
                "<p>As of ${esc((r.asOf ?: "no sync yet").toString())}; computed at ${esc(r.now.toString())}. Counts, timings and rule outcomes only.</p>",
            )
            for (s in r.sections) {
                appendLine("<h2 id=\"${esc(s.id)}\">${esc(s.title)}</h2>")
                if (!s.available) {
                    appendLine("<p><em>Not available: ${esc(s.note.orEmpty())}</em></p>")
                } else {
                    s.note?.let {
                        appendLine("<p><em>Note: ${esc(it)}</em></p>")
                    }
                }
                for (t in s.tables) {
                    appendLine("<h3>${esc(t.title)}</h3><table><tr>${t.header.joinToString("") { "<th>${esc(it)}</th>" }}</tr>")
                    for (row in t.rows) appendLine("<tr>${row.joinToString("") { "<td>${esc(it)}</td>" }}</tr>")
                    appendLine("</table>")
                }
            }
            appendLine("</body></html>")
        }
}

/** Writes the report and the export into a conference's export directory (spec §10.4 G). The app and the tests use the same calls. */
public object ReportFiles {
    /** `<app data>/exports/<conference id>`: outside the repo and any synced folder by default; the system property `pcs.exportDir` moves it (tests). */
    public fun dir(
        s: Session,
        env: Map<String, String>,
    ): java.nio.file.Path =
        (System.getProperty("pcs.exportDir")?.let(java.nio.file.Path::of) ?: net.jonbell.pcs.core.session.AppDirs.data(env).resolve("exports"))
            .resolve(s.conference.id)

    /** `process-report.md` and `process-report.html` in [dir]. */
    public fun saveReport(s: Session, dir: java.nio.file.Path): List<java.nio.file.Path> {
        val r = ProcessReports.build(s)
        java.nio.file.Files.createDirectories(dir)
        return listOf("md" to ReportRender.markdown(r), "html" to ReportRender.html(r)).map { (ext, text) ->
            dir.resolve("process-report.$ext").also { java.nio.file.Files.writeString(it, text) }
        }
    }

    /** The pseudonymous rows as CSV files in [dir]; the key comes from the settings. Null when no key is set (nothing is written). */
    public fun saveExport(s: Session, dir: java.nio.file.Path): List<java.nio.file.Path>? {
        val ps = Pseudonyms.resolve(s.settings.raw) ?: return null
        return PseudonymousExport.write(PseudonymousExport.build(s, ps), dir)
    }
}
