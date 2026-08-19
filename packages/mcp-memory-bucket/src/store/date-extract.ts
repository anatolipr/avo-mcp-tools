const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WRITTEN_MONTH_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi;

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function stripCodeBlocks(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '');
}

/** Extracts unique ISO (YYYY-MM-DD) dates mentioned in free text — conservative by design: only unambiguous formats (ISO, written-month-with-year) are matched, code blocks and slash-dates are skipped entirely. */
export function extractDates(body: string): string[] {
  const text = stripCodeBlocks(body);
  const dates = new Set<string>();

  for (const match of text.matchAll(ISO_DATE_RE)) {
    const [, y, m, d] = match;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (isValidDate(year, month, day)) dates.add(`${y}-${m}-${d}`);
  }

  for (const match of text.matchAll(WRITTEN_MONTH_RE)) {
    const [, monthName, dayStr, yearStr] = match;
    const month = MONTHS[monthName!.toLowerCase()];
    const day = Number(dayStr);
    const year = Number(yearStr);
    if (month && isValidDate(year, Number(month), day)) {
      dates.add(`${yearStr}-${month}-${String(day).padStart(2, '0')}`);
    }
  }

  return Array.from(dates).sort();
}

/**
 * Converts a UTC ISO timestamp (e.g. created_at) to the calendar date it
 * falls on in the given IANA timezone (default: the OS timezone this
 * process is running in). Distinct from extractDates()'s output, which is
 * already timezone-naive text — this exists specifically so a UTC instant
 * lands on the same calendar date a user in that timezone would call "today".
 */
export function toLocalDate(isoTimestamp: string, timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return formatter.format(new Date(isoTimestamp));
}
