import { parse } from 'csv-parse/sync';

export function parseRecipients(input) {
  const rows = parse(input, { bom: true, columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const headers = Object.keys(rows[0] ?? {});
  const emailColumn = headers.find((header) => /email/i.test(header)) ?? headers.find((header) => /mail/i.test(header));
  if (!emailColumn) throw new Error('CSV needs a column whose name contains "email" or "mail".');
  return rows.filter((row) => Object.values(row).some((value) => String(value ?? '').trim())).map((row, index) => {
    const email = String(row[emailColumn] ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid email in CSV row ${index + 2}: ${email || '(blank)'}`);
    return { email, name: String(row.name ?? row.Name ?? '').trim(), data: row };
  });
}
