import type { FintrackDb } from "../db";
import type { RulesFile } from "../config";
import { isoNow } from "../utils/time";
import { merchantKey } from "../utils/text";

export interface RulesIndex {
  aliasByRawKey: Map<string, string>;
  ignore: Set<string>;
  force: Set<string>;
}

export const loadRulesIntoTables = (db: FintrackDb, rules: RulesFile): RulesIndex => {
  const now = isoNow();
  const tx = db.db.transaction(() => {
    db.db.exec("DELETE FROM rule_alias_merchant;");
    db.db.exec("DELETE FROM rule_ignore_merchant;");
    db.db.exec("DELETE FROM rule_force_subscription;");

    const insertAlias = db.db.query(
      "INSERT INTO rule_alias_merchant (raw_key, canonical_merchant) VALUES (?, ?)"
    );
    const insertIgnore = db.db.query(
      "INSERT INTO rule_ignore_merchant (merchant_key, reason, updated_at) VALUES (?, ?, ?)"
    );
    const insertForce = db.db.query(
      "INSERT INTO rule_force_subscription (merchant_key, reason, updated_at) VALUES (?, ?, ?)"
    );

    for (const [raw, canonical] of Object.entries(rules.aliases)) {
      const rawKey = merchantKey(raw);
      const canonicalMerchant = canonical.trim();
      if (!rawKey || !canonicalMerchant) {
        continue;
      }
      insertAlias.run(rawKey, canonicalMerchant);
    }

    for (const item of rules.ignore) {
      const key = merchantKey(item.merchant);
      if (!key) {
        continue;
      }
      insertIgnore.run(key, item.reason ?? "", now);
    }

    for (const item of rules.force) {
      const key = merchantKey(item.merchant);
      if (!key) {
        continue;
      }
      insertForce.run(key, item.reason ?? "", now);
    }
  });

  tx();

  return buildRulesIndex(db);
};

export const buildRulesIndex = (db: FintrackDb): RulesIndex => {
  const aliasRows = db.db
    .query("SELECT raw_key, canonical_merchant FROM rule_alias_merchant")
    .all() as Array<{ raw_key: string; canonical_merchant: string }>;
  const ignoreRows = db.db
    .query("SELECT merchant_key FROM rule_ignore_merchant")
    .all() as Array<{ merchant_key: string }>;
  const forceRows = db.db
    .query("SELECT merchant_key FROM rule_force_subscription")
    .all() as Array<{ merchant_key: string }>;

  const aliasByRawKey = new Map<string, string>();
  for (const row of aliasRows) {
    aliasByRawKey.set(row.raw_key, row.canonical_merchant);
  }

  return {
    aliasByRawKey,
    ignore: new Set(ignoreRows.map((row) => row.merchant_key)),
    force: new Set(forceRows.map((row) => row.merchant_key)),
  };
};
