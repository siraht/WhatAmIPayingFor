import type { FintrackDb } from "../db";
import { jaccardSimilarity } from "../utils/text";
import { diffDays } from "../utils/time";

interface TxRow {
  ynab_transaction_id: string;
  merchant_key: string;
  txn_date: string;
  amount_minor: number;
  currency: string;
}

interface EmailRow {
  canonical_email_evidence_id: string;
  merchant_key: string;
  datetime: string;
  item_name_norm: string | null;
  item_price_minor: number | null;
  currency: string;
  amount_evidence_type: string;
}

interface MatchCandidate {
  ynabTransactionId: string;
  canonicalEmailEvidenceId: string;
  score: number;
  reasonCodes: string[];
  dateDistance: number;
  merchantSimilarity: number;
}

const scoreCandidate = (tx: TxRow, email: EmailRow): MatchCandidate | null => {
  const reasons: string[] = [];
  let score = 0;

  const emailDate = email.datetime?.slice(0, 10);
  if (!emailDate) {
    return null;
  }

  const dateDistance = Math.abs(diffDays(tx.txn_date, emailDate));
  if (dateDistance > 3) {
    return null;
  }

  if (dateDistance === 0) {
    score += 0.2;
    reasons.push("R_DATE_SAME_DAY");
  } else if (dateDistance === 1) {
    score += 0.15;
    reasons.push("R_DATE_1D");
  } else if (dateDistance === 2) {
    score += 0.1;
    reasons.push("R_DATE_2D");
  } else {
    score += 0.05;
    reasons.push("R_DATE_3D");
  }

  const merchantSimilarity = jaccardSimilarity(tx.merchant_key, email.merchant_key);
  if (merchantSimilarity >= 0.9) {
    score += 0.2;
    reasons.push("R_MERCHANT_HIGH");
  } else if (merchantSimilarity >= 0.7) {
    score += 0.15;
    reasons.push("R_MERCHANT_MEDIUM");
  } else if (merchantSimilarity >= 0.5) {
    score += 0.08;
    reasons.push("R_MERCHANT_LOW");
  }

  if (tx.currency === email.currency) {
    score += 0.1;
    reasons.push("R_CURRENCY_MATCH");
  } else {
    reasons.push("R_CURRENCY_MISMATCH");
  }

  const emailAmount = email.item_price_minor;
  if (emailAmount != null && tx.currency === email.currency) {
    const diff = Math.abs(tx.amount_minor - emailAmount);
    if (diff === 0) {
      let amountScore = 0.45;
      if (email.amount_evidence_type === "item_price") {
        amountScore *= 0.7;
        reasons.push("R_AMOUNT_LINE_ITEM_ONLY");
      }
      score += amountScore;
      reasons.push("R_AMOUNT_EXACT");
    } else {
      const tolerance = Math.max(100, Math.round(tx.amount_minor * 0.03));
      if (diff <= tolerance) {
        let amountScore = 0.25;
        if (email.amount_evidence_type === "item_price") {
          amountScore *= 0.7;
          reasons.push("R_AMOUNT_LINE_ITEM_ONLY");
        }
        amountScore -= 0.08;
        score += Math.max(0, amountScore);
        reasons.push("R_AMOUNT_TOLERANT");
      }
    }
  } else {
    reasons.push("R_NO_AMOUNT_EVIDENCE");
  }

  if (email.item_name_norm && tx.merchant_key) {
    const token = tx.merchant_key.split(" ")[0] || "";
    if (token && email.item_name_norm.toLowerCase().includes(token.toLowerCase())) {
      score += 0.05;
      reasons.push("R_ITEM_NAME_SIGNAL");
    }
  }

  const clipped = Math.max(0, Math.min(1, Number(score.toFixed(4))));
  if (clipped < 0.25) {
    return null;
  }

  return {
    ynabTransactionId: tx.ynab_transaction_id,
    canonicalEmailEvidenceId: email.canonical_email_evidence_id,
    score: clipped,
    reasonCodes: reasons,
    dateDistance,
    merchantSimilarity,
  };
};

export interface RecomputeMatchesResult {
  transactionsConsidered: number;
  candidatePairs: number;
  winnerPairs: number;
}

export const recomputeMatches = (db: FintrackDb): RecomputeMatchesResult => {
  const txRows = db.db
    .query(
      `SELECT ynab_transaction_id, merchant_key, txn_date, amount_minor, currency
       FROM normalized_transaction
       WHERE include_in_spend = 1 AND is_outflow = 1`
    )
    .all() as TxRow[];

  const emailRows = db.db
    .query(
      `SELECT canonical_email_evidence_id, merchant_key, datetime, item_name_norm,
              item_price_minor, currency, amount_evidence_type
       FROM normalized_email_purchase`
    )
    .all() as EmailRow[];
  const emailRowsWithDatetime = emailRows.filter((row) => row.datetime);

  const allCandidates: MatchCandidate[] = [];
  for (const tx of txRows) {
    for (const email of emailRowsWithDatetime) {
      const candidate = scoreCandidate(tx, email);
      if (candidate) {
        allCandidates.push(candidate);
      }
    }
  }

  const byTxn = new Map<string, MatchCandidate[]>();
  for (const candidate of allCandidates) {
    const bucket = byTxn.get(candidate.ynabTransactionId) ?? [];
    bucket.push(candidate);
    byTxn.set(candidate.ynabTransactionId, bucket);
  }

  const tx = db.db.transaction(() => {
    db.db.exec("DELETE FROM transaction_email_match;");
    const insert = db.db.query(
      `INSERT INTO transaction_email_match (
        ynab_transaction_id, canonical_email_evidence_id, score,
        reason_codes, is_winner, matched_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))`
    );

    for (const [txnId, matches] of byTxn.entries()) {
      matches.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        if (a.dateDistance !== b.dateDistance) {
          return a.dateDistance - b.dateDistance;
        }
        if (b.merchantSimilarity !== a.merchantSimilarity) {
          return b.merchantSimilarity - a.merchantSimilarity;
        }
        return a.canonicalEmailEvidenceId.localeCompare(b.canonicalEmailEvidenceId);
      });

      matches.forEach((match, index) => {
        insert.run(
          txnId,
          match.canonicalEmailEvidenceId,
          match.score,
          JSON.stringify(match.reasonCodes),
          index === 0 ? 1 : 0
        );
      });
    }
  });

  tx();

  return {
    transactionsConsidered: txRows.length,
    candidatePairs: allCandidates.length,
    winnerPairs: Array.from(byTxn.values()).filter((rows) => rows.length > 0).length,
  };
};
