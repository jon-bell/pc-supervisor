// Incremental RFC 4180 CSV parser for large imports (a 1.44M-row affinity
// matrix): feed text in chunks of any size, get each row with the 1-based
// line it starts on as soon as it is complete. Same grammar and error
// messages as parseCsvLines in ../hotcrp/csv.ts (quoted fields, "" escapes,
// CR/LF/CRLF, newlines inside quotes, optional BOM, blank lines skipped), but
// memory stays bounded by the longest row, not the file.

import { CsvError, type CsvLine } from "../hotcrp/csv.js";

export class CsvStreamParser {
  readonly #onRow: (row: CsvLine) => void;
  #row: string[] = [];
  #field = "";
  // start: at the beginning of a field; bare: inside an unquoted field;
  // quoted: inside quotes; closed: just after a quote inside a quoted field
  // (either the closing quote or the first half of a "" escape).
  #state: "start" | "bare" | "quoted" | "closed" = "start";
  #line = 1;
  #rowLine = 1;
  #quoteLine = 1;
  #skipLf = false;
  #first = true;

  constructor(onRow: (row: CsvLine) => void) {
    this.#onRow = onRow;
  }

  #endField(): void {
    this.#row.push(this.#field);
    this.#field = "";
    this.#state = "start";
  }

  #endRow(): void {
    if (this.#row.length > 0 || this.#field !== "" || this.#state !== "start") {
      this.#endField();
      const cells = this.#row;
      this.#row = [];
      this.#onRow({ line: this.#rowLine, cells });
    }
    this.#row = [];
    this.#state = "start";
  }

  /** Feed the next piece of text. Throws CsvError on a syntax error. */
  push(text: string): void {
    let i = 0;
    if (this.#first && text.length > 0) {
      this.#first = false;
      if (text.charCodeAt(0) === 0xfeff) i = 1;
    }
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (this.#skipLf) {
        this.#skipLf = false;
        if (c === "\n") continue;
      }
      if (this.#state === "quoted") {
        if (c === '"') {
          this.#state = "closed";
        } else if (c === "\n") {
          this.#line++;
          this.#field += c;
        } else {
          // Copy the run of plain characters in one slice.
          let j = i + 1;
          while (j < text.length && text[j] !== '"' && text[j] !== "\n") j++;
          this.#field += text.slice(i, j);
          i = j - 1;
        }
        continue;
      }
      if (this.#state === "closed" && c === '"') {
        // "" inside a quoted field: a literal quote.
        this.#field += '"';
        this.#state = "quoted";
        continue;
      }
      if (c === ",") {
        this.#endField();
      } else if (c === "\n" || c === "\r") {
        if (c === "\r") this.#skipLf = true;
        this.#endRow();
        this.#line++;
        this.#rowLine = this.#line;
      } else if (this.#state === "closed") {
        throw new CsvError(`line ${this.#line}: text after a closing quote`);
      } else if (c === '"') {
        if (this.#state === "bare") throw new CsvError(`line ${this.#line}: quote inside an unquoted field`);
        this.#state = "quoted";
        this.#quoteLine = this.#line;
      } else {
        let j = i + 1;
        while (j < text.length) {
          const d = text[j];
          if (d === "," || d === "\n" || d === "\r" || d === '"') break;
          j++;
        }
        this.#field += text.slice(i, j);
        i = j - 1;
        this.#state = "bare";
      }
    }
  }

  /** End of input: flush the last row. */
  end(): void {
    if (this.#state === "quoted") throw new CsvError(`line ${this.#quoteLine}: unterminated quoted field`);
    this.#endRow();
  }
}
