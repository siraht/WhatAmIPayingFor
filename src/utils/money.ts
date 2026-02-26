export const milliunitsToMinor = (milliunits: number): number => Math.round(Math.abs(milliunits) / 10);

export const minorToDisplay = (minor: number, currency = "USD"): string => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(minor / 100);
};

export const parsePriceToMinor = (value: string): number | null => {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^[-+]?\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  return Math.round(Number(normalized) * 100);
};
