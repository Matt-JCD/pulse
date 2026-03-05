const SYDNEY_TIMEZONE = 'Australia/Sydney';

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string | undefined {
  return parts.find((p) => p.type === type)?.value;
}

export function getSydneyDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const day = getPart(parts, 'day');

  if (!year || !month || !day) {
    throw new Error('Failed to derive Sydney date parts');
  }

  return `${year}-${month}-${day}`;
}

function getOffsetMsForTimeZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const year = Number(getPart(parts, 'year'));
  const month = Number(getPart(parts, 'month'));
  const day = Number(getPart(parts, 'day'));
  const hour = Number(getPart(parts, 'hour'));
  const minute = Number(getPart(parts, 'minute'));
  const second = Number(getPart(parts, 'second'));

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
}

/**
 * Converts UTC ISO string to a datetime-local value interpreted in Sydney time.
 */
export function toSydneyDateTimeLocalValue(isoString: string | null): string {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const year = getPart(parts, 'year');
  const month = getPart(parts, 'month');
  const day = getPart(parts, 'day');
  const hour = getPart(parts, 'hour');
  const minute = getPart(parts, 'minute');

  if (!year || !month || !day || !hour || !minute) return '';
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Converts a Sydney-local datetime-local value (YYYY-MM-DDTHH:mm) to UTC ISO.
 */
export function sydneyLocalDateTimeToUtcIso(value: string): string {
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) {
    throw new Error(`Invalid datetime-local value: ${value}`);
  }

  const [yearRaw, monthRaw, dayRaw] = datePart.split('-');
  const [hourRaw, minuteRaw] = timePart.split(':');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid datetime-local value: ${value}`);
  }

  const localGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMs = getOffsetMsForTimeZone(localGuess, SYDNEY_TIMEZONE);
  return new Date(localGuess.getTime() - offsetMs).toISOString();
}

/**
 * Safe wrapper for user input conversion.
 */
export function trySydneyLocalDateTimeToUtcIso(value: string): string | null {
  try {
    return sydneyLocalDateTimeToUtcIso(value);
  } catch {
    return null;
  }
}
