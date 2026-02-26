export const printTable = (headers: string[], rows: Array<Array<string | number>>): void => {
  const widths = headers.map((header, idx) => {
    return Math.max(header.length, ...rows.map((row) => String(row[idx] ?? "").length));
  });

  const render = (cells: Array<string | number>): string =>
    cells.map((cell, idx) => String(cell ?? "").padEnd(widths[idx])).join("  ");

  process.stdout.write(`${render(headers)}\n`);
  process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) {
    process.stdout.write(`${render(row)}\n`);
  }
};

export const emitJson = (data: unknown): void => {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
};
