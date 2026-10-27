export type CsvRecord = Record<string, string>;

export function parseCsvRecords(text: string): CsvRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.trim().length === 0) {
      field = "";
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n" || character === "\r") {
      row.push(field.trim());
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      if (character === "\r" && input[index + 1] === "\n") index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(field.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must include a header row and at least one listing row.");

  const headers = rows[0].map((header) => header.trim().toLocaleLowerCase("en").replace(/[\s-]+/g, "_"));
  if (headers.some((header) => !header)) throw new Error("CSV column names cannot be empty.");
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate column names.");

  return rows.slice(1).map((values, rowIndex) => {
    if (values.length > headers.length) throw new Error(`CSV row ${rowIndex + 2} has more values than headers.`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

export function parseCsv(text: string): CsvRecord[] {
  const records = parseCsvRecords(text);
  const headers = new Set(Object.keys(records[0] ?? {}));
  const required = ["title", "property_type", "area", "city", "country_code"];
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(", ")}.`);
  return records;
}
