package net.jonbell.pcs.core.imports

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CsvTest {
    @Test
    fun `quotes, doubled quotes, embedded newlines, CRLF, BOM, blank lines`() {
        val csv = Csv.parse("﻿a,b\r\n1,\"x, \"\"y\"\"\"\r\n\r\n\"two\nlines\",3\r\n").getOrThrow()
        assertEquals(listOf("a", "b"), csv.header)
        assertEquals(listOf(2 to listOf("1", "x, \"y\""), 4 to listOf("two\nlines", "3")), csv.records)
    }

    @Test
    fun `a final record without a newline, and empty fields`() {
        val csv = Csv.parse("a,b,c\n1,,3").getOrThrow()
        assertEquals(listOf(2 to listOf("1", "", "3")), csv.records)
    }

    @Test
    fun `broken quoting is an error with a line`() {
        val e = Csv.parse("a,b\n1,x\"y\n").exceptionOrNull() as CsvError
        assertEquals(2, e.line)
        assertTrue(Csv.parse("a\n\"open").exceptionOrNull() is CsvError)
    }
}
