// Small RFC 4180 CSV parser: quoted fields, "" escapes, CR/LF/CRLF line
// endings, newlines inside quotes, optional BOM. HotCRP's list actions
// (e.g. get/pcassignments) return CSV.

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/** Parse CSV text into rows of fields. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  // start: at the beginning of a field; bare: inside an unquoted field;
  // quoted: inside quotes; closed: just after a closing quote.
  let state: "start" | "bare" | "quoted" | "closed" = "start";
  let line = 1;

  const endField = () => {
    row.push(field);
    field = "";
    state = "start";
  };
  const endRow = () => {
    // A row with no fields and nothing typed is a blank line: skip it.
    if (row.length > 0 || field !== "" || state !== "start") {
      endField();
      rows.push(row);
    }
    row = [];
    state = "start";
  };

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i]!;
    if (state === "quoted") {
      if (c !== '"') {
        if (c === "\n") line++;
        field += c;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        state = "closed";
      }
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else if (state === "closed") {
      throw new CsvError(`line ${line}: text after a closing quote`);
    } else if (c === '"') {
      if (state === "bare") throw new CsvError(`line ${line}: quote inside an unquoted field`);
      state = "quoted";
    } else {
      field += c;
      state = "bare";
    }
  }
  if (state === "quoted") throw new CsvError(`line ${line}: unterminated quoted field`);
  endRow();
  return rows;
}

/**
 * Parse CSV with a header row into records. Short rows simply lack the
 * trailing keys (HotCRP omits trailing empty cells); long rows are an error.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  return body.map((cells, n) => {
    if (cells.length > header.length) {
      throw new CsvError(`row ${n + 2}: ${cells.length} fields but the header has ${header.length}`);
    }
    const rec: Record<string, string> = {};
    cells.forEach((v, j) => {
      rec[header[j]!] = v;
    });
    return rec;
  });
}
