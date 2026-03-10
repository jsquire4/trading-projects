/**
 * RFC 4180–compliant CSV builder and download helper.
 */

/** Quote a field if it contains a comma, double-quote, or newline. */
function escapeField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n") || field.includes("\r")) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

/**
 * Build a CSV string from headers and rows.
 * Uses CRLF line endings per RFC 4180.
 */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines: string[] = [headers.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Trigger a browser download of a CSV string.
 * Creates a temporary object URL, clicks a hidden anchor, then revokes the URL.
 */
export function downloadCsv(data: string, filename: string): void {
  const blob = new Blob([data], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
