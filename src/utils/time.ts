const DAY_MS = 24 * 60 * 60 * 1000;

export const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

export const parseIsoDate = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  return parsed;
};

export const parseYearMonth = (value: string): { year: number; month: number } => {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid month format: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month number: ${month}`);
  }
  return { year, month };
};

export const monthRange = (value: string): { start: string; end: string } => {
  const { year, month } = parseYearMonth(value);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
};

export const addDays = (isoDate: string, days: number): string => {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const diffDays = (a: string, b: string): number => {
  const d1 = parseIsoDate(a).getTime();
  const d2 = parseIsoDate(b).getTime();
  return Math.round((d1 - d2) / DAY_MS);
};

export const isoNow = (): string => new Date().toISOString();

export const dateToIsoDate = (date: Date): string => {
  const normalized = new Date(date.getTime());
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized.toISOString().slice(0, 10);
};

export const daysAgoDate = (days: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

export const clampDayToMonth = (year: number, month1Based: number, day: number): number => {
  const lastDay = new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
  return Math.min(day, lastDay);
};
