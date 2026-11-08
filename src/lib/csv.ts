/**
 * One CSV cell. Cells a spreadsheet would read as a formula (starting with = + - @, tab or CR)
 * get a leading apostrophe; cells with commas, quotes or line breaks are quoted.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
