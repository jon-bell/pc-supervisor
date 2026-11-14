package pcs.core.imports

/** A parsed CSV: the header, and each record with the 1-based line it started on. */
public class Csv(public val header: List<String>, public val records: List<Pair<Int, List<String>>>) {
    public companion object {
        /**
         * RFC 4180: quoted fields may hold commas, quotes (doubled), and newlines. Returns
         * [CsvError] for an unterminated quote or a stray quote; blank lines are skipped.
         */
        public fun parse(input: String): Result<Csv> {
            val text = input.removePrefix("﻿")
            val recs = mutableListOf<Pair<Int, List<String>>>()
            var fields = mutableListOf<String>()
            val sb = StringBuilder()
            var line = 1
            var start = 1
            var i = 0
            var quoted = false
            var wasQuoted = false
            var any = false

            fun endField() {
                fields += if (wasQuoted) sb.toString() else sb.toString().trim()
                sb.clear()
                wasQuoted = false
            }

            fun endRecord() {
                endField()
                if (any || fields.size > 1 || fields[0].isNotEmpty()) recs += start to fields
                fields = mutableListOf()
                any = false
            }
            while (i < text.length) {
                val ch = text[i]
                if (quoted) {
                    when {
                        ch == '"' && text.getOrNull(i + 1) == '"' -> {
                            sb.append('"')
                            i++
                        }
                        ch == '"' -> quoted = false
                        else -> {
                            if (ch == '\n') line++
                            sb.append(ch)
                        }
                    }
                } else {
                    when (ch) {
                        '"' -> {
                            if (sb.isNotBlank()) return Result.failure(CsvError(line, "a quote in the middle of an unquoted field"))
                            sb.clear()
                            quoted = true
                            wasQuoted = true
                            any = true
                        }
                        ',' -> {
                            endField()
                            any = true
                        }
                        '\r' -> {}
                        '\n' -> {
                            endRecord()
                            line++
                            start = line
                        }
                        else -> sb.append(ch)
                    }
                }
                i++
            }
            if (quoted) return Result.failure(CsvError(start, "an unterminated quoted field"))
            if (sb.isNotEmpty() || fields.isNotEmpty() || any) endRecord()
            if (recs.isEmpty()) return Result.failure(CsvError(1, "the file is empty (no header row)"))
            val header = recs.first().second.map { it.trim() }
            return Result.success(Csv(header, recs.drop(1)))
        }
    }
}

public class CsvError(public val line: Int, message: String) : IllegalArgumentException(message)
