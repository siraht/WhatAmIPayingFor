import type { FintrackDb } from "../db";
import { merchantKey, sanitizeItemName } from "../utils/text";
import { isoNow } from "../utils/time";

interface RawEmail {
  canonical_email_evidence_id: string;
  datetime: string | null;
  sender_domain: string | null;
  item_name: string | null;
  item_price_minor: number | null;
  currency: string | null;
  amount_evidence_type: string | null;
  parse_confidence: number | null;
  parser_version: string | null;
  inserted_at: string;
}

export interface NormalizeEmailsResult {
  processedRawRows: number;
  canonicalRows: number;
}

export const normalizeEmailPurchases = (db: FintrackDb): NormalizeEmailsResult => {
  const rows = db.db
    .query(
      `SELECT canonical_email_evidence_id, datetime, sender_domain, item_name, item_price_minor,
              currency, amount_evidence_type, parse_confidence, parser_version, inserted_at
       FROM raw_email_purchase
       ORDER BY inserted_at DESC`
    )
    .all() as RawEmail[];

  const bestByCanonical = new Map<string, RawEmail>();
  for (const row of rows) {
    const existing = bestByCanonical.get(row.canonical_email_evidence_id);
    if (!existing) {
      bestByCanonical.set(row.canonical_email_evidence_id, row);
      continue;
    }
    const rowConfidence = row.parse_confidence ?? 0;
    const existingConfidence = existing.parse_confidence ?? 0;
    if (rowConfidence > existingConfidence) {
      bestByCanonical.set(row.canonical_email_evidence_id, row);
    }
  }

  const tx = db.db.transaction(() => {
    db.db.exec("DELETE FROM normalized_email_purchase;");
    const insert = db.db.query(
      `INSERT INTO normalized_email_purchase (
        canonical_email_evidence_id, datetime, merchant_key, item_name_norm,
        item_price_minor, currency, amount_evidence_type, parse_confidence,
        parser_version, normalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const row of bestByCanonical.values()) {
      const merchant = merchantKey(row.sender_domain || "unknown");
      insert.run(
        row.canonical_email_evidence_id,
        row.datetime,
        merchant,
        row.item_name ? sanitizeItemName(row.item_name) : null,
        row.item_price_minor,
        row.currency || "USD",
        row.amount_evidence_type || "unknown",
        row.parse_confidence ?? 0,
        row.parser_version || "email-parser-v1",
        isoNow()
      );
    }
  });

  tx();

  return {
    processedRawRows: rows.length,
    canonicalRows: bestByCanonical.size,
  };
};
