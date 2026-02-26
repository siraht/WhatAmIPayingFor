import { spawnSync } from "node:child_process";
import net from "node:net";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { AppError } from "../errors";
import { EXIT } from "../constants";
import type { FintrackDb } from "../db";
import { getSyncCursor, setSyncCursor } from "../db/sync-state";
import { sha256 } from "../utils/hash";
import { rootDomain, sanitizeItemName } from "../utils/text";
import { isoNow } from "../utils/time";
import type { Logger } from "../logger";

const COMMERCE_SUBJECT_PATTERNS = [
  /receipt/i,
  /invoice/i,
  /order/i,
  /subscription/i,
  /payment/i,
  /charged/i,
  /renewal/i,
  /your bill/i,
];

const COMMERCE_SENDER_HINTS = [
  "amazon",
  "apple",
  "google",
  "microsoft",
  "stripe",
  "paypal",
  "netflix",
  "spotify",
  "hulu",
  "adobe",
  "doordash",
  "uber",
  "lyft",
  "walmart",
  "target",
  "invoice",
  "billing",
  "receipt",
  "charge",
];

const SYMBOL_TO_CURRENCY: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
};

interface ParseOutcome {
  itemName: string | null;
  itemPriceMinor: number | null;
  amountEvidenceType: "item_price" | "order_total" | "unknown";
  currency: string;
  parseConfidence: number;
  parseStatus: "parsed" | "candidate_no_price" | "no_candidate" | "parse_failed";
}

export interface EmailSyncConfig {
  host: string;
  port: number;
  user: string;
  passCmd: string;
  folders: string[];
  accountLabel: string;
}

export interface SyncEmailOptions {
  days: number;
  deepParse?: boolean;
  dryRun?: boolean;
  parserVersion: string;
  resetCursor?: boolean;
  logger: Logger;
}

export interface SyncEmailResult {
  foldersProcessed: number;
  messagesSeen: number;
  messagesParsed: number;
  messagesUpserted: number;
  usedCursorFolders: number;
}

const parsePassCommand = (command: string): string => {
  const result = spawnSync("bash", ["-lc", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new AppError("Failed to run IMAP password command", {
      code: "EMAIL_PASS_CMD_FAILED",
      details: { stderr: result.stderr.trim() },
    });
  }
  const pass = result.stdout.trim();
  if (!pass) {
    throw new AppError("IMAP password command returned empty output", {
      code: "EMAIL_PASS_EMPTY",
    });
  }
  return pass;
};

export const probeBridge = async (host: string, port: number, timeoutMs = 1250): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
};

const isCandidateMessage = (senderDomain: string, subject: string): boolean => {
  if (COMMERCE_SENDER_HINTS.some((hint) => senderDomain.includes(hint))) {
    return true;
  }
  return COMMERCE_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject));
};

const pickAmount = (text: string): { amount: number; currency: string; evidence: "item_price" | "order_total" } | null => {
  const normalized = text.replace(/\s+/g, " ");
  const amountPattern = "([0-9]+(?:,[0-9]{3})*(?:\\.\\d{2})?)";

  const keywordRegex =
    new RegExp(
      `(?:order total|total charged|amount charged|payment total|charged|invoice total)[^$€£\\\\d]{0,24}([$€£])\\\\s?${amountPattern}`,
      "gi"
    );
  const genericRegex = new RegExp(`([$€£])\\\\s?${amountPattern}`, "g");

  const parse = (symbol: string, amountRaw: string): { amount: number; currency: string } | null => {
    const parsed = Number(amountRaw.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return {
      amount: Math.round(parsed * 100),
      currency: SYMBOL_TO_CURRENCY[symbol] ?? "USD",
    };
  };

  const keywordMatches: Array<{ amount: number; currency: string }> = [];
  for (const match of normalized.matchAll(keywordRegex)) {
    const parsed = parse(match[1], match[2]);
    if (parsed) {
      keywordMatches.push(parsed);
    }
  }
  if (keywordMatches.length > 0) {
    keywordMatches.sort((a, b) => b.amount - a.amount);
    return { amount: keywordMatches[0].amount, currency: keywordMatches[0].currency, evidence: "order_total" };
  }

  const genericMatches: Array<{ amount: number; currency: string }> = [];
  for (const match of normalized.matchAll(genericRegex)) {
    const parsed = parse(match[1], match[2]);
    if (parsed) {
      genericMatches.push(parsed);
    }
  }

  if (genericMatches.length === 0) {
    return null;
  }

  genericMatches.sort((a, b) => b.amount - a.amount);
  return { amount: genericMatches[0].amount, currency: genericMatches[0].currency, evidence: "item_price" };
};

const extractOutcome = async (rawSource: Buffer, subject: string, candidate: boolean): Promise<ParseOutcome> => {
  try {
    const parsed = await simpleParser(rawSource);
    const text = `${parsed.subject ?? ""}\n${parsed.text ?? ""}`;
    const amount = pickAmount(text);
    const itemName = sanitizeItemName((parsed.subject || subject || "").slice(0, 180));

    if (!amount) {
      return {
        itemName: itemName || null,
        itemPriceMinor: null,
        amountEvidenceType: "unknown",
        currency: "USD",
        parseConfidence: candidate ? 0.35 : 0.15,
        parseStatus: candidate ? "candidate_no_price" : "parsed",
      };
    }

    const confidence = Math.min(
      0.98,
      0.35 +
        (candidate ? 0.15 : 0) +
        (itemName ? 0.2 : 0) +
        (amount.evidence === "order_total" ? 0.28 : 0.2)
    );

    return {
      itemName: itemName || null,
      itemPriceMinor: amount.amount,
      amountEvidenceType: amount.evidence,
      currency: amount.currency,
      parseConfidence: confidence,
      parseStatus: "parsed",
    };
  } catch {
    return {
      itemName: null,
      itemPriceMinor: null,
      amountEvidenceType: "unknown",
      currency: "USD",
      parseConfidence: candidate ? 0.1 : 0,
      parseStatus: "parse_failed",
    };
  }
};

const buildLogicalDedupeKey = (messageIdHash: string, senderDomain: string, datetimeIso: string): string => {
  const timestampBucket = Math.floor(new Date(datetimeIso).getTime() / (10 * 60 * 1000));
  return `${messageIdHash}:${senderDomain}:${timestampBucket}`;
};

const findCanonicalEvidenceId = (
  db: FintrackDb,
  messageIdHash: string,
  senderDomain: string,
  datetimeIso: string,
  pendingByLogicalKey: Map<string, string>
): string => {
  const logicalKey = buildLogicalDedupeKey(messageIdHash, senderDomain, datetimeIso);
  const pendingCanonical = pendingByLogicalKey.get(logicalKey);
  if (pendingCanonical) {
    return pendingCanonical;
  }

  const candidates = db.db
    .query(
      `SELECT canonical_email_evidence_id, datetime
       FROM raw_email_purchase
       WHERE message_id_hash = ? AND sender_domain = ?
       ORDER BY inserted_at DESC
       LIMIT 8`
    )
    .all(messageIdHash, senderDomain) as Array<{
    canonical_email_evidence_id: string;
    datetime: string;
  }>;

  const targetMs = new Date(datetimeIso).getTime();
  for (const candidate of candidates) {
    if (!candidate.datetime) {
      continue;
    }
    const ms = new Date(candidate.datetime).getTime();
    if (Number.isNaN(ms)) {
      continue;
    }
    if (Math.abs(ms - targetMs) <= 10 * 60 * 1000) {
      pendingByLogicalKey.set(logicalKey, candidate.canonical_email_evidence_id);
      return candidate.canonical_email_evidence_id;
    }
  }

  const canonical = sha256(logicalKey);
  pendingByLogicalKey.set(logicalKey, canonical);
  return canonical;
};

const upsertRawEmail = (
  db: FintrackDb,
  data: {
    messageKey: string;
    messageIdHash: string;
    canonicalEmailEvidenceId: string;
    account: string;
    folder: string;
    uid: number;
    uidvalidity: string;
    datetimeIso: string;
    senderDomain: string;
    subjectHash: string;
    itemName: string | null;
    itemPriceMinor: number | null;
    amountEvidenceType: string;
    currency: string;
    parseConfidence: number;
    parseStatus: string;
    parserVersion: string;
    rawMetadataJson: string;
  }
): void => {
  db.db
    .query(
      `INSERT INTO raw_email_purchase (
        message_key, message_id_hash, canonical_email_evidence_id,
        account, folder, uid, uidvalidity, datetime,
        sender_domain, subject_hash, item_name, item_price_minor,
        amount_evidence_type, currency, parse_confidence, parse_status,
        parser_version, raw_metadata_json, inserted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_key) DO UPDATE SET
        message_id_hash = excluded.message_id_hash,
        canonical_email_evidence_id = excluded.canonical_email_evidence_id,
        datetime = excluded.datetime,
        sender_domain = excluded.sender_domain,
        subject_hash = excluded.subject_hash,
        item_name = excluded.item_name,
        item_price_minor = excluded.item_price_minor,
        amount_evidence_type = excluded.amount_evidence_type,
        currency = excluded.currency,
        parse_confidence = excluded.parse_confidence,
        parse_status = excluded.parse_status,
        parser_version = excluded.parser_version,
        raw_metadata_json = excluded.raw_metadata_json,
        inserted_at = excluded.inserted_at`
    )
    .run(
      data.messageKey,
      data.messageIdHash,
      data.canonicalEmailEvidenceId,
      data.account,
      data.folder,
      data.uid,
      data.uidvalidity,
      data.datetimeIso,
      data.senderDomain,
      data.subjectHash,
      data.itemName,
      data.itemPriceMinor,
      data.amountEvidenceType,
      data.currency,
      data.parseConfidence,
      data.parseStatus,
      data.parserVersion,
      data.rawMetadataJson,
      isoNow()
    );
};

export const syncEmail = async (
  db: FintrackDb,
  config: EmailSyncConfig,
  options: SyncEmailOptions
): Promise<SyncEmailResult> => {
  const password = parsePassCommand(config.passCmd);

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: false,
    auth: {
      user: config.user,
      pass: password,
    },
    logger: false,
  });

  const stats: SyncEmailResult = {
    foldersProcessed: 0,
    messagesSeen: 0,
    messagesParsed: 0,
    messagesUpserted: 0,
    usedCursorFolders: 0,
  };

  try {
    await client.connect();
  } catch (error) {
    throw new AppError("Failed to connect to IMAP server", {
      exitCode: EXIT.AUTH_FAILURE,
      code: "EMAIL_CONNECT_FAILED",
      details: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    for (const folder of config.folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        const mailbox = client.mailbox;
        const uidValidity = mailbox === false ? "0" : String(mailbox?.uidValidity ?? "0");
        const mailboxMaxUid = mailbox === false ? 0 : Math.max(0, Number((mailbox?.uidNext ?? 1) - 1));
        const scope = `account:${config.accountLabel}:folder:${folder}`;
        const cursor = options.resetCursor ? null : getSyncCursor(db, "email", scope);
        const hasCursor =
          !!cursor && typeof cursor.last_uid === "number" && String(cursor.uidvalidity ?? "") === uidValidity;
        if (hasCursor) {
          stats.usedCursorFolders += 1;
        }

        const metadataRows: Array<{ uid: number; envelope: any; internalDate: Date }> = [];

        if (hasCursor) {
          const startUid = (cursor?.last_uid as number) + 1;
          if (startUid <= mailboxMaxUid) {
            for await (const msg of client.fetch(`${startUid}:*`, {
              uid: true,
              envelope: true,
              internalDate: true,
            })) {
              const internalDate = msg.internalDate;
              metadataRows.push({
                uid: msg.uid,
                envelope: msg.envelope,
                internalDate:
                  internalDate instanceof Date
                    ? internalDate
                    : internalDate
                      ? new Date(internalDate)
                      : new Date(),
              });
            }
          }
        } else {
          const since = new Date();
          since.setDate(since.getDate() - options.days);
          const searchResult = await client.search({ since });
          const uids = Array.isArray(searchResult) ? searchResult : [];
          if (uids.length > 0) {
            for await (const msg of client.fetch(uids, {
              uid: true,
              envelope: true,
              internalDate: true,
            })) {
              const internalDate = msg.internalDate;
              metadataRows.push({
                uid: msg.uid,
                envelope: msg.envelope,
                internalDate:
                  internalDate instanceof Date
                    ? internalDate
                    : internalDate
                      ? new Date(internalDate)
                      : new Date(),
              });
            }
          }
        }

        if (metadataRows.length === 0) {
          if (!options.dryRun) {
            const cursorPayload = {
              uidvalidity: uidValidity,
              last_uid: hasCursor ? Number(cursor?.last_uid ?? 0) : mailboxMaxUid,
              last_seen_datetime: cursor?.last_seen_datetime ?? null,
              updated_at: isoNow(),
            };
            setSyncCursor(db, "email", scope, cursorPayload);
          }
          stats.foldersProcessed += 1;
          continue;
        }

        let maxUid = hasCursor ? (cursor?.last_uid as number) : 0;
        let lastSeenDatetime: string | null = hasCursor
          ? (String(cursor?.last_seen_datetime ?? "") || null)
          : null;
        const pendingCanonicalByLogicalKey = new Map<string, string>();

        const pendingRows: Array<{
          messageKey: string;
          messageIdHash: string;
          canonicalEmailEvidenceId: string;
          account: string;
          folder: string;
          uid: number;
          uidvalidity: string;
          datetimeIso: string;
          senderDomain: string;
          subjectHash: string;
          itemName: string | null;
          itemPriceMinor: number | null;
          amountEvidenceType: string;
          currency: string;
          parseConfidence: number;
          parseStatus: string;
          parserVersion: string;
          rawMetadataJson: string;
        }> = [];

        for (const msg of metadataRows) {
          stats.messagesSeen += 1;
          maxUid = Math.max(maxUid, msg.uid);

          const fromValue = msg.envelope?.from?.[0]?.address || msg.envelope?.from?.[0]?.name || "unknown";
          const senderDomain = rootDomain(String(fromValue));
          const subject = String(msg.envelope?.subject ?? "");
          const datetime = msg.internalDate instanceof Date ? msg.internalDate : new Date();
          const datetimeIso = datetime.toISOString();
          lastSeenDatetime = datetimeIso;

          const candidate = isCandidateMessage(senderDomain, subject);
          const shouldParseBody = options.deepParse || candidate;

          let outcome: ParseOutcome = {
            itemName: sanitizeItemName(subject) || null,
            itemPriceMinor: null,
            amountEvidenceType: "unknown",
            currency: "USD",
            parseConfidence: candidate ? 0.25 : 0,
            parseStatus: candidate ? "candidate_no_price" : "no_candidate",
          };

          if (shouldParseBody) {
            const full = await client.fetchOne(msg.uid, { source: true });
            const source = full === false ? undefined : full?.source;
            if (source) {
              stats.messagesParsed += 1;
              outcome = await extractOutcome(source as Buffer, subject, candidate);
            } else {
              outcome = {
                ...outcome,
                parseStatus: "parse_failed",
                parseConfidence: 0.05,
              };
            }
          }

          const messageId = msg.envelope?.messageId
            ? String(msg.envelope.messageId)
            : `${config.accountLabel}/${folder}/${uidValidity}/${msg.uid}`;
          const messageKey = `${config.accountLabel}:${folder}:${uidValidity}:${msg.uid}`;
          const messageIdHash = sha256(`${config.accountLabel}:${messageId}`);
          const subjectHash = sha256(subject);
          const canonicalEmailEvidenceId = findCanonicalEvidenceId(
            db,
            messageIdHash,
            senderDomain,
            datetimeIso,
            pendingCanonicalByLogicalKey
          );

          pendingRows.push({
            messageKey,
            messageIdHash,
            canonicalEmailEvidenceId,
            account: config.accountLabel,
            folder,
            uid: msg.uid,
            uidvalidity: uidValidity,
            datetimeIso,
            senderDomain,
            subjectHash,
            itemName: outcome.itemName,
            itemPriceMinor: outcome.itemPriceMinor,
            amountEvidenceType: outcome.amountEvidenceType,
            currency: outcome.currency,
            parseConfidence: outcome.parseConfidence,
            parseStatus: outcome.parseStatus,
            parserVersion: options.parserVersion,
            rawMetadataJson: JSON.stringify({
              from: fromValue,
              candidate,
              subjectLength: subject.length,
            }),
          });
        }

        if (options.dryRun) {
          stats.messagesUpserted += pendingRows.length;
        } else {
          const tx = db.db.transaction(() => {
            for (const row of pendingRows) {
              upsertRawEmail(db, row);
              stats.messagesUpserted += 1;
            }

            setSyncCursor(db, "email", scope, {
              uidvalidity: uidValidity,
              last_uid: maxUid,
              last_seen_datetime: lastSeenDatetime,
              updated_at: isoNow(),
            });
          });

          tx();
        }

        stats.foldersProcessed += 1;
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  options.logger.info("Email sync complete", stats);
  return stats;
};
