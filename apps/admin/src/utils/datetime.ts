/**
 * Browser-locale datetime formatting for Admin UI.
 *
 * Uses `Intl.DateTimeFormat(undefined, …)` so language, region, 12/24h, and
 * timezone follow the user's browser / OS settings — not a fixed app string
 * and not forced to the app i18n locale unless the browser matches it.
 */

export type DateInput = string | number | Date | null | undefined;

const EMPTY = "—";

function toDate(value: DateInput): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Full date + time (medium) in the browser locale/timezone. */
export function formatDateTime(value: DateInput, empty: string = EMPTY): string {
  const d = toDate(value);
  if (!d) return empty;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** Date only (medium) in the browser locale/timezone. */
export function formatDate(value: DateInput, empty: string = EMPTY): string {
  const d = toDate(value);
  if (!d) return empty;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/** Time only (medium/short) in the browser locale/timezone. */
export function formatTime(value: DateInput, empty: string = EMPTY): string {
  const d = toDate(value);
  if (!d) return empty;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/**
 * Compact datetime for charts / dense tooltips (still browser locale).
 * e.g. "Jul 26, 10:48:45 PM" / "7月26日 22:48:45"
 */
export function formatDateTimeCompact(value: DateInput, empty: string = EMPTY): string {
  const d = toDate(value);
  if (!d) return empty;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** Range display for shifts / windows. Same-day → time–time; else full datetimes. */
export function formatDateTimeRange(
  start: DateInput,
  end: DateInput,
  empty: string = EMPTY,
): string {
  const a = toDate(start);
  const b = toDate(end);
  if (!a && !b) return empty;
  if (!a) return formatDateTime(b, empty);
  if (!b) return formatDateTime(a, empty);
  const sameDay =
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay) {
    return `${formatTime(a)} – ${formatTime(b)}`;
  }
  return `${formatDateTime(a)} – ${formatDateTime(b)}`;
}

/**
 * ProTable / ProDescriptions render helper — always returns a string suitable
 * for table cells (never throws).
 */
export function renderDateTime(value: DateInput): string {
  return formatDateTime(value);
}
