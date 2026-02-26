const STOP_WORDS = new Set([
  "payment",
  "purchase",
  "order",
  "invoice",
  "receipt",
  "subscription",
  "txn",
  "transaction",
]);

export const normalizeSpaces = (value: string): string => value.replace(/\s+/g, " ").trim();

export const merchantKey = (value: string): string => {
  return normalizeSpaces(value.toLowerCase().replace(/[^a-z0-9\s]/g, " ")).replace(/\s+/g, " ").trim();
};

export const sanitizeItemName = (value: string): string => {
  return normalizeSpaces(
    value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/\b\d{6,}\b/g, "[redacted-number]")
      .replace(/\b(order|invoice|ref)\s*#?\s*[a-z0-9-]+/gi, "")
  );
};

export const jaccardSimilarity = (a: string, b: string): number => {
  const ta = new Set(merchantKey(a).split(" ").filter((token) => token && !STOP_WORDS.has(token)));
  const tb = new Set(merchantKey(b).split(" ").filter((token) => token && !STOP_WORDS.has(token)));
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
};

export const rootDomain = (input: string): string => {
  const host = input.toLowerCase().replace(/^.*@/, "").replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return host;
  }
  return parts.slice(-2).join(".");
};
