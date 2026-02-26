import type { FintrackDb } from "./db";
import type { FintrackConfig } from "./types";
import type { RulesFile } from "./config";
import { loadRulesIntoTables } from "./rules";
import { normalizeTransactions } from "./normalize/transactions";
import { normalizeEmailPurchases } from "./normalize/email";
import { recomputeMatches } from "./derive/matching";
import { recomputeRecurring } from "./derive/recurring";

export interface RecomputePipelineResult {
  normalizedTransactions: ReturnType<typeof normalizeTransactions>;
  normalizedEmails: ReturnType<typeof normalizeEmailPurchases>;
  matches: ReturnType<typeof recomputeMatches>;
  recurring: ReturnType<typeof recomputeRecurring>;
}

export const recomputeDerivedLayers = (
  db: FintrackDb,
  config: FintrackConfig,
  rulesFile: RulesFile
): RecomputePipelineResult => {
  const rules = loadRulesIntoTables(db, rulesFile);

  const normalizedTransactions = normalizeTransactions(db, config.currency, rules);
  const normalizedEmails = normalizeEmailPurchases(db);
  const matches = recomputeMatches(db);
  const recurring = recomputeRecurring(db, rules);

  return {
    normalizedTransactions,
    normalizedEmails,
    matches,
    recurring,
  };
};
