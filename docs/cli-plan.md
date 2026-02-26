# Finance Tracking CLI Plan (KISS MVP, Revised)

Last revised: 2026-02-26

## 1) Objective
Build a terminal-first tool that creates a reliable monthly view of:
- subscriptions and recurring purchases
- total spending by merchant/category/account
- upcoming expected charges

Data sources:
- YNAB transactions and scheduled transactions (source of truth for money movement)
- Proton Mail Bridge IMAP purchase confirmations (enrichment for item/price evidence)

Terminology note:
- YNAB API path parameter names often use `plan_id`.
- This project uses `budget_id` in CLI/config for readability.
- In implementation, treat them as the same identifier.

## 2) Product Principles
- KISS first: prefer simple deterministic rules over complex ML.
- Correctness over cleverness: do not lose or duplicate financial records.
- Explainability: every subscription decision must have reasons.
- Privacy by default: do not store raw email bodies.
- CLI first, automation friendly, GUI later.

## 3) Key Decisions and Rationale

### Decision A: Canonical data store is SQLite (not CSV/Markdown)
Rationale:
- We need idempotent upserts, transactional checkpoints, and robust dedupe.
- We need repeat joins/grouping for matching and recurrence logic.
- SQLite keeps MVP simple while remaining reliable and fast.
- CSV/Markdown remain useful as export formats, not canonical storage.

Implementation method:
- Use one SQLite DB in `state-dir`.
- Export reports and debug snapshots to CSV/Markdown on demand.

### Decision B: Keep a 3-layer data architecture
Layers:
1. `raw_ingest`: source-derived records with stable identifiers and minimal selected fields.
2. `normalized`: canonical merchant/date/amount representations.
3. `derived_insights`: matches, recurring candidates, predictions, confidence.

Rationale:
- Makes debugging and contributor onboarding much easier.
- Prevents accidental destruction of source evidence when logic changes.
- Enables deterministic recomputation of derived layers.
- Preserves privacy goals by avoiding unnecessary storage of sensitive raw email content.

### Decision C: YNAB is the transaction source of truth in MVP
Rationale:
- Avoids direct bank connector complexity.
- Works with linked accounts or file import for Discover, Citi, and Texas Capital Bank.
- Keeps scope focused on analysis quality.

### Decision D: Store only extracted email fields (item + price + minimal metadata)
Rationale:
- Meets privacy goal while retaining matching utility.
- Supports idempotency and reprocessing without raw body retention.

Important:
- "minimal metadata" is strictly operational (dedupe, ordering, confidence), not rich message content.

Stored email fields:
- `message_key` (stable dedupe fingerprint, recommended: `account + folder + uidvalidity + uid`)
- `message_id_hash` (logical dedupe aid across folder moves/copies)
- `canonical_email_evidence_id` (stable id after logical dedupe consolidation)
- `datetime`
- `sender_domain`
- `subject_hash` (optional; hash only, no plaintext subject persistence)
- `item_name`
- `item_price`
- `amount_evidence_type` (e.g., `item_price`, `order_total`, `unknown`)
- `currency`
- `parse_confidence`
- `parser_version`

Parse-status rule:
- persist parse outcomes even when `item_name` or `item_price` cannot be extracted, to prevent endless reparsing loops.

If UID-based metadata is unavailable in a specific client workflow, fallback to:
- `message-id + account` (with collision checks)
- if both UID metadata and Message-ID are unavailable, mark as non-canonical and lower matching confidence

Not stored by default:
- raw body
- attachments
- full PII-rich content

Sanitization note:
- normalize and sanitize extracted `item_name` to remove obvious personal tokens when feasible.

## 4) CLI Contract

### Command Tree
```text
fintrack
  setup
    ynab
    email
  sync
    ynab
    email
    all
  report
    spend
    subscriptions
    upcoming
  doctor
```

Usability note:
- `fintrack sync` without a subcommand should behave as `fintrack sync all`.

### Usage Synopsis
```bash
fintrack setup ynab --token-env YNAB_TOKEN --budget-id last-used
fintrack setup email --imap-host 127.0.0.1 --imap-port 1143 --imap-user "<bridge-user>" --imap-pass-cmd "pass show fintrack/bridge"
fintrack sync ynab --since 2025-01-01
fintrack sync email --days 365
fintrack sync all --days 365
fintrack report spend --month 2026-02 --group-by merchant
fintrack report subscriptions --month 2026-02 --explain
fintrack report upcoming --days 30 --visual
fintrack doctor --json
```

### Global Flags
- `-h`, `--help`
- `--version`
- `--json`
- `--no-input`
- `--config <path>`
- `--state-dir <path>`
- `--verbose`

### Selected Command Flags
- `setup ynab`:
  - `--token-env <name>` default `YNAB_TOKEN`
  - `--budget-id <id|last-used|default>`
  - `--dry-run`
- `setup email`:
  - `--imap-host <host>` default `127.0.0.1`
  - `--imap-port <port>` default `1143` (auto-detect preferred when probing Bridge)
  - `--imap-user <value>`
  - `--imap-pass-cmd <command>`
  - `--folders <csv>` default `Inbox`
  - `--probe-bridge` (enabled by default)
  - `--no-probe-bridge`
  - `--dry-run`
- `sync ynab`:
  - `--since <YYYY-MM-DD>`
  - `--dry-run`
- `sync email`:
  - `--days <n>` default `365`
  - `--deep-parse` (force body parse for all candidate messages)
  - `--dry-run`
- `report subscriptions`:
  - `--month <YYYY-MM>`
  - `--min-confidence <0..1>` default `0.65`
  - `--include-usage-based`
  - `--explain`
- `report upcoming`:
  - `--days <n>` default `30`
  - `--min-confidence <0..1>` default `0.65`
  - `--visual` (ASCII date view)

### I/O and Exit Codes
- stdout: primary results, JSON if `--json`.
- stderr: diagnostics/errors.
- exit codes:
  - `0` success
  - `1` runtime failure
  - `2` invalid arguments
  - `3` auth failure
  - `4` upstream failure/rate limit exhaustion
  - `5` partial success

## 5) Sync and Idempotency Design

### Per-source sync state (required)
Track checkpoints in `sync_state` by source and scope:
- YNAB scope: `budget_id + endpoint`, cursor=`last_knowledge_of_server`
- Email scope: `account + folder`, cursor=`uidvalidity + last_uid + last_seen_datetime`

Rationale:
- Supports resume after failure.
- Prevents duplicate ingest and missing windows.

### Command behavior
- `sync ynab`: pull YNAB deltas only.
- `sync email`: ingest/parse email only.
- `sync all`: run `sync ynab` then `sync email` then recompute derived insights.

`sync email --days` semantics:
- used as initial backfill window when no checkpoint exists
- after checkpoint exists, incremental sync should be cursor-driven, not full re-scan

`sync ynab --since` semantics:
- used for first backfill or explicit re-bootstrap workflows
- once delta cursor exists, prefer cursor-driven sync unless user explicitly resets state

Reset rule:
- resetting cursors must be explicit and should require confirmation unless `--force` is provided.

### Transactional checkpoint rule
Only advance cursor/checkpoint after records are successfully written in the same DB transaction.

## 6) Data Model (Contributor Blueprint)

This is a recommended MVP schema shape, not a rigid final schema.

Core tables:
- `sync_state`
- `raw_ynab_transaction`
- `raw_ynab_scheduled_transaction`
- `raw_email_purchase`
- `normalized_transaction`
- `normalized_email_purchase`
- `transaction_email_match`
- `recurring_candidate`
- `recurring_occurrence`
- `rule_alias_merchant`
- `rule_ignore_merchant`
- `rule_force_subscription`
- `schema_version`

Key uniqueness constraints:
- `raw_ynab_transaction`: unique `ynab_transaction_id`
- `raw_email_purchase`: unique `message_key`
- `transaction_email_match`: unique `(ynab_transaction_id, canonical_email_evidence_id)`

Logical dedupe rule for email:
- if `message_id_hash` matches an existing record with same sender domain and near-identical datetime, treat as duplicate evidence (even if folder/UID differs)
- matching should target `canonical_email_evidence_id` to prevent duplicate confidence inflation

## 7) Matching and Recurring Logic

### Stage 1: Eligibility filter (before recurrence)
Exclude or down-weight:
- transfers
- credit card payments
- reimbursements/refunds/chargebacks (where identifiable)
- obvious one-off adjustments
- duplicate counting between parent transactions and subtransactions

Rationale:
- Reduces false positives significantly.

Implementation note:
- use YNAB structural fields first (`transfer_account_id`, `subtransactions`, `debt_transaction_type`) before falling back to text heuristics.
- for spend reporting, use a single canonical representation (parent-only or leaf-only) to avoid parent/subtransaction double counting.

### Stage 2: Matching transactions to email evidence
Features:
- exact amount match preferred
- small absolute/relative tolerance may be used when seller descriptors or taxes cause slight differences
- date proximity window (default +/- 3 days)
- normalized merchant similarity
- optional item-name signal from email parser
- timezone-normalized date comparison (YNAB date-only vs email datetime)
- currency compatibility check before amount scoring
- user-local timezone as default normalization context (configurable)

Amount-evidence rule:
- prioritize `order_total` evidence for amount matching when available.
- if only line-item price evidence exists, reduce weight of amount matching.

Tolerance safeguard:
- when tolerant amount matching is used, apply a confidence penalty and require stronger merchant/date agreement.

Persist:
- score
- reason codes
- selected winning match

Tie-break policy:
- if multiple candidates have equal score, break ties deterministically (date proximity, then canonical merchant similarity, then stable lexical key).

Currency policy (MVP):
- assume budget currency is canonical for totals/reporting
- if email currency differs and no trusted conversion is available, do not hard-match by amount
- normalize monetary values to integer minor units before scoring to avoid floating-point errors

### Stage 3: Recurring/subscription detection
Base criteria:
- cadence-aware minimum occurrences and observation windows
- interval consistency (weekly/monthly/quarterly/yearly buckets)
- controlled amount variance

Cadence-aware defaults (MVP):
- weekly/monthly: minimum 3 occurrences in 180 days
- quarterly: minimum 2 occurrences in 365 days
- yearly: minimum 2 occurrences in 730 days
- sparse-history exception: allow lower counts when strong YNAB scheduled-transaction evidence exists

Cadence bucket coverage:
- include biweekly/every-4-weeks cadence handling so payroll-like periodicity is not forced into monthly buckets.

Sparse-history safeguard:
- when sparse-history exception is used, cap confidence below the highest confidence band until more observed occurrences arrive.

Rationale:
- prevents systematic false negatives for low-frequency subscriptions.

Prior boost:
- if aligned with YNAB scheduled transaction cadence/payee, boost confidence.

Confidence guardrails:
- cap maximum confidence when evidence sources are correlated
- avoid double-counting scheduled-transaction and historical-interval evidence
- require minimum independent evidence for very high confidence classifications
- include base-rate-aware priors (e.g., discretionary merchants start with lower subscription prior)

### Stage 4: User overrides (rules)
Contributor/user-managed rules file loaded into rule tables:
- merchant aliases
- ignore merchants
- force subscription merchants

Precedence:
1. alias normalization to canonical merchant
2. force/ignore rules on canonical merchant
3. heuristic classifier

Rule authoring note:
- normalize rule entries at load time so contributors can write either raw or canonical merchant spellings without changing behavior.

### Explainability contract
Every subscription candidate must include reason codes, for example:
- `R_INTERVAL_MONTHLY_STABLE`
- `R_AMOUNT_STABLE`
- `R_MATCHED_EMAIL_EVIDENCE`
- `R_MATCHED_YNAB_SCHEDULED`
- `R_RULE_FORCED`
- `R_RULE_IGNORED`

Score semantics:
- confidence values are ranking scores in `[0,1]`, not guaranteed calibrated probabilities.
- treat thresholding as an operational decision rule unless explicit probability calibration is performed.

## 8) Performance and Reliability

### YNAB API policy
- Respect 200 requests/hour/token.
- Use delta endpoints and bounded request windows.
- Retry strategy for transient failures:
  - exponential backoff with jitter on `429/5xx`
  - fail with partial-success exit code if retry budget exhausted

### Email parsing policy
Two-pass approach:
1. Candidate indexing: scan message metadata and known sender/subject patterns.
2. Body parse: parse full body for candidates to extract item/price.

Coverage safeguard:
- if candidate rules are absent or too restrictive, run a bounded broad scan mode to reduce false-negative misses.

Privacy constraint during parsing:
- subject/body may be inspected in-memory for parsing, but plaintext should not be persisted by default.

Reparse policy:
- Do not reparse unchanged messages unless `parser_version` changed or `--deep-parse` is requested.

Rationale:
- Keeps extraction quality high without repeated full-history body parsing.

## 9) Reporting

### `report spend`
Outputs:
- totals by merchant/category/account
- top spenders
- optional JSON output for downstream automation

Default spend-flow rule:
- exclude obvious non-spend flows (transfers, credit card payments, balance adjustments) unless explicitly included by flag/config.

### `report subscriptions`
Outputs:
- merchant, typical amount, cadence
- last charge date, predicted next charge date
- confidence score
- explainability reason codes (`--explain`)

Calibration note:
- keep `--min-confidence` default empirically calibrated against real fixture results; revise only with measured precision/recall impact.
- evaluate calibration on a holdout fixture set to reduce overfitting to development fixtures.
- periodically check calibration drift as merchants, parsers, and user rules evolve.

### `report upcoming`
Outputs:
- expected charges over next N days
- sorted by expected date
- daily and weekly projected totals
- `--visual` ASCII timeline/calendar style output for quick CLI scanning
- default include rule: only candidates above configured confidence threshold

Stability rule:
- if multiple predictions share the same date and score, apply deterministic ordering (merchant key, then amount, then id).

Prediction method (MVP):
- use median observed interval per recurring candidate
- preserve day-of-month when monthly; clamp to last day for short months
- expose confidence and source reasons beside each predicted charge
- yearly/leap-day handling: map Feb 29 predictions to Feb 28 in non-leap years unless stronger merchant-specific evidence suggests another convention.

## 10) Testing Strategy (Real Data Policy)

Policy:
- Core logic tests must use captured real payloads from YNAB and Proton Bridge workflows.
- No synthetic fake business data for core matching/detection assertions.
- Redaction of sensitive values is required, but structure/semantics must remain real.
- If protocol-level failure scenarios are tested (e.g., `429`), use replay of captured real API responses or live env-gated runs.

Scope clarification:
- synthetic inputs are acceptable for low-level pure utility tests (e.g., date parser helpers), but not for end-to-end business outcome assertions.

Test layers:
1. Fixture replay unit/integration tests:
  - real YNAB JSON payloads
  - real `.eml` samples from Proton Bridge-backed mailboxes
2. Deterministic end-to-end CLI tests:
  - ingest -> merge -> recurring detection -> report output
3. Optional live smoke tests (env-gated):
  - run against live YNAB/Bridge only when credentials are explicitly provided

Fixture governance:
- keep a versioned fixture manifest with source date range and redaction notes
- do not silently mutate fixture semantics when updating redactions

Critical user-flow outcomes to test:
- rerunning sync does not duplicate
- crash mid-sync then rerun recovers without gaps
- YNAB delta cursor correctness over multiple runs
- email dedupe correctness over multiple runs
- accurate merge of email evidence into the right transaction
- recurring detection quality on real regular charges
- spend/subscription/upcoming reports tally real data correctly
- rate-limit handling behavior on forced `429` responses
- timezone boundary correctness near midnight transaction/email timestamps
- split-transaction handling does not distort merchant totals or recurring classification
- refunds/reversals do not incorrectly create or inflate recurring candidates
- `report upcoming` date ordering and projected totals remain stable across reruns
- low-frequency (quarterly/yearly) subscriptions are correctly detected with sparse but real history
- deleted transactions from YNAB deltas correctly remove or downgrade derived recurring conclusions
- leap-year and short-month prediction behavior remains deterministic and policy-compliant

## 11) Migration and Versioning

Because SQLite is canonical:
- include `schema_version`
- use forward-only migrations
- validate migrations in CI by upgrading older DB snapshots and verifying report outputs

Rationale:
- Keeps contributor changes safe as schema and heuristics evolve.

## 12) Implementation Phases

### Phase 1: Core ingest and spend reporting
- `setup ynab`, `sync ynab`, `report spend`
- per-source sync state table (YNAB)
- initial real-fixture tests

### Phase 2: Email enrichment pipeline
- `setup email`, `sync email`
- two-pass candidate/body parsing
- store only extracted fields (item/price + minimal metadata)
- dedupe and merge tests

### Phase 3: Recurring intelligence
- eligibility filter
- recurring detector with scheduled-transaction prior
- user override rules
- explainability reason codes
- `report subscriptions`

### Phase 4: Forecast and hardening
- `report upcoming --visual`
- rate-limit/retry hardening
- migration coverage, reliability tests, packaging polish

## 13) Contributor Notes
- Keep modules separated by pipeline stage:
  - `ingest/`
  - `normalize/`
  - `derive/`
  - `report/`
  - `rules/`
  - `migrations/`
- Do not write to YNAB in MVP.
- Keep outputs deterministic (stable sort keys, stable rounding).
- Any new heuristic must add reason codes and tests.
- Any schema change must include a migration and migration test.

## 14) Source Constraints (Research-backed)
- YNAB API:
  - Personal access tokens are appropriate for single-user local CLI.
  - Delta sync via `server_knowledge` / `last_knowledge_of_server`.
  - Rate limit is 200 requests per hour per token.
  - Transactions and scheduled transactions endpoints are available.
  - Transaction endpoints return posted transactions and exclude pending transactions.
- YNAB import behavior:
  - File import supports QFX/OFX/QIF and CSV.
- Proton Bridge:
  - Bridge runs local IMAP/SMTP servers.
  - CLI mode supported via `--cli` / `-c`.
  - Local host binding defaults around IMAP 1143 / SMTP 1025 with free-port fallback behavior.

## 15) Research Links
- https://api.ynab.com/
- https://github.com/ynab/ynab-sdk-js/blob/main/open_api_spec.yaml
- https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo
- https://support.ynab.com/en_us/formatting-a-csv-file-an-overview-BJvczkuRq
- https://support.ynab.com/en_us/how-direct-import-works-H1IGYLgnxl
- https://support.ynab.com/en_us/linked-accounts-B1991f2Cc
- https://github.com/ProtonMail/proton-bridge/blob/master/README.md
- https://github.com/ProtonMail/proton-bridge/blob/master/BUILDS.md
- https://github.com/ProtonMail/proton-bridge/blob/master/internal/constants/constants.go
- https://github.com/ProtonMail/proton-bridge/blob/master/internal/vault/types_settings.go
- https://github.com/ProtonMail/proton-bridge/blob/master/tests/features/bridge/default_ports.feature
- https://proton.me/support/bridge-cli-guide

## 16) Implementation Execution Log (2026-02-26)

### 16.1 Build path used
- Skill used: `t-create-cli` (build-from-scratch path, Tier 2 framework escalation).
- Rationale: command surface is nested and broad (`setup/sync/report/doctor` + multiple flags + exit-code contract), so Commander-based Tier 2 implementation is justified.

### 16.2 Project scaffold and runtime decisions
- Runtime selected: Bun + TypeScript.
- Rationale:
  - Fast local execution and testing (`bun run`, `bun test`).
  - Built-in SQLite support (`bun:sqlite`) simplified canonical store implementation.
- CLI parser selected: Commander.
- Rationale:
  - Nested command tree and option validation exceed Tier 1 simplicity threshold.

### 16.3 Implemented deliverables
- CLI contract implemented:
  - `setup ynab`, `setup email`
  - `sync ynab`, `sync email`, `sync all`, and default `sync => sync all`
  - `report spend`, `report subscriptions`, `report upcoming`
  - `doctor`
- Global flags implemented:
  - `--json`, `--no-input`, `--config`, `--state-dir`, `--verbose`, `--version`, help.
- Exit code contract implemented:
  - `0,1,2,3,4,5` per plan.
- SQLite canonical store implemented with forward-only migration framework and schema version tracking.
- 3-layer architecture implemented:
  - `raw_ingest` tables: YNAB + email extraction records.
  - `normalized` tables: canonical transaction/email forms.
  - `derived_insights` tables: matches + recurring candidates/occurrences.
- Idempotent checkpointing implemented:
  - `sync_state` maintained by source/scope.
  - cursor updates occur in same DB transaction as writes.
- YNAB ingest implemented:
  - delta sync with `last_knowledge_of_server`
  - scheduled transactions ingest
  - retry with exponential backoff/jitter for `429/5xx`
  - auth error mapping to exit code `3`.
- Email ingest implemented (Proton Bridge IMAP path):
  - cursoring by account/folder with `uidvalidity + last_uid + last_seen_datetime`
  - candidate indexing + optional deep parsing
  - extracted-only storage (no raw body persistence)
  - logical dedupe with canonical evidence ID.
- Matching and recurrence implemented:
  - score + reason codes + deterministic tie-break
  - cadence detection incl. `biweekly` and `every_4_weeks`
  - sparse-history scheduled-transaction safeguard
  - confidence guardrails + rule overrides.
- Reporting implemented:
  - spend grouping
  - subscriptions with optional explainability
  - upcoming forecast + deterministic ordering + ASCII `--visual`.
- Rules pipeline implemented:
  - `rules.json` bootstrap
  - alias/ignore/force loaded into rule tables before derive stages.

### 16.4 Commands verified manually
Manual verification was run using isolated temporary `--state-dir` values.

Observed exit behavior:
- `setup ynab` with explicit budget id and no token: succeeds.
- `setup email` with dummy pass command and no probe: succeeds.
- `doctor`: returns partial success (`exit 5`) when warnings exist.
- `sync ynab` without token env present: `exit 3` with clear auth error.
- `sync email` when IMAP endpoint unavailable: `exit 3` with connect error.
- `sync all` when all stages fail: `exit 1` with stage-wise details.

### 16.5 Automated tests added and run
Commands executed during build:
- `bun x tsc --noEmit`
- `bun test`

Current test suite:
1. `test/derive-matching.test.ts`
- Validates deterministic tie-break when scores are equal.
2. `test/derive-recurring.test.ts`
- Validates monthly cadence and short-month prediction clamp (Jan 31 -> Feb 28).
3. `test/migrations.test.ts`
- Validates forward-only migration behavior across DB reopen.
4. `test/cli-smoke.test.ts`
- Validates CLI doctor JSON path and partial-success exit code behavior.

Most recent run status:
- Type check: pass.
- Tests: 4 passed, 0 failed.

### 16.6 Additional implementation choices resolved during build
- `doctor` exit behavior:
  - Decision: return `exit 5` on warnings/missing setup rather than always `0`.
  - Rationale: aligns with partial-success contract and CI automation needs.
- Report recomputation:
  - Decision: recompute normalize+derive before report commands.
  - Rationale: ensures reports remain consistent after rule updates or staged sync operations.
- Cursor reset safety:
  - Decision: added reset safeguards (`--reset-cursor`, confirmation or `--force`).
  - Rationale: aligns with explicit reset policy and prevents accidental re-bootstrap.

### 16.7 Learnings and lessons from tool/runtime behavior
- `imapflow` API typing can return `false` sentinels in union types (`mailbox`, `fetchOne` results).
- SQLite transactions in this stack must remain synchronous; async network/body parsing must be completed before entering DB transaction.
- Commander default behavior requires explicit handling to preserve custom exit code map across nested commands.
- Running isolated CLI smoke tests with temporary `--state-dir` is effective for reproducible verification without production secrets.

### 16.8 Usage instructions captured during implementation
For local/no-credential development:
- Run setup paths and health checks:
  - `fintrack setup ynab --budget-id <id>`
  - `fintrack setup email --imap-user <u> --imap-pass-cmd "<cmd>" --no-probe-bridge`
  - `fintrack doctor --json`
- Run quality gates:
  - `bun x tsc --noEmit`
  - `bun test`

For live integration once credentials are available:
- Export token env matching setup value, e.g. `export YNAB_TOKEN=...`
- Ensure Proton Bridge is running and IMAP endpoint is reachable.
- Run:
  - `fintrack sync ynab`
  - `fintrack sync email --days 365`
  - `fintrack sync all`

### 16.9 Known gaps and next hardening tasks
- Real captured fixture corpus is still required to fully satisfy the real-data fixture policy for business-level assertions.
- Live YNAB and Proton Bridge smoke tests remain pending until credentials are provided.
- Email parsing heuristics are intentionally conservative for MVP and should be refined against captured `.eml` samples.
- Foreign-currency handling currently avoids hard amount matching when currency differs; conversion integration is not yet implemented.

## 17) Fresh-Eyes QA Pass (2026-02-26)

A full post-implementation audit was run with static checks, CLI probes, and new regression tests.

### 17.1 Issues found and fixed

1. `sync email --dry-run` wrote data to SQLite
- Problem: dry-run mode still executed raw email upserts.
- Fix: gate writes behind `!dryRun`; dry-run now inspects/parses but performs no DB writes or cursor updates.
- File: `src/ingest/email.ts`

2. Invalid numeric/date flags were inconsistently validated
- Problem examples:
  - `report spend --month bad` returned runtime error (`exit 1`) instead of invalid args.
  - `report upcoming --days -5` returned success with reversed date window.
  - `sync ynab --since not-a-date` could bypass format validation.
  - `setup email --imap-port 70000` was accepted.
- Fix:
  - Added central validators (`src/utils/validate.ts`) for ISO date, YYYY-MM, integer range, enum.
  - Enforced validation in setup/sync/report command handlers.
  - Invalid input now maps to `exit 2` with structured error codes.

3. `sync` parent/subcommand flag capture caused option loss
- Problem: duplicated flags at `sync` and `sync <subcommand>` levels could be captured only on parent, making subcommand handlers miss user input.
- Fix: subcommand actions merge parent options before execution.
- File: `src/cli.ts`

4. Split child transactions could be counted toward spend
- Problem: normalized spend eligibility did not explicitly exclude child split transactions (`parent_transaction_id` rows), allowing double counting risk.
- Fix: include `parent_transaction_id` in normalization query and exclude child rows with reason `R_SUBTRANSACTION_CHILD`.
- File: `src/normalize/transactions.ts`

5. Upcoming forecast could truncate long weekly horizons
- Problem: hardcoded loop guard (`64`) capped projections for long horizons.
- Fix: dynamic iteration budget derived from forecast horizon.
- File: `src/report/upcoming.ts`

6. Human output hardcoded totals currency as USD
- Problem: spend/upcoming totals display ignored configured currency.
- Fix: carry configured currency from command layer and render with that currency.
- Files: `src/commands/report.ts`, `src/cli.ts`

### 17.2 Regression tests added

- `test/cli-validation.test.ts`
  - invalid month rejected
  - negative upcoming days rejected
  - invalid sync `--since` rejected
  - IMAP port out-of-range rejected
- `test/normalize-transactions.test.ts`
  - split child transaction excluded from spend
- `test/report-upcoming.test.ts`
  - long weekly horizon not truncated near 64 occurrences

### 17.3 Verification results after fixes

- `bun x tsc --noEmit` -> pass
- `bun test` -> pass (`10` passed, `0` failed)
- Manual CLI probes confirm corrected exit semantics:
  - invalid month/date/integer now return `exit 2` with explicit error codes.

## 18) Fresh-Eyes QA Pass #2 (2026-02-26)

A second independent audit uncovered additional issues not caught in the first sweep.

### 18.1 Issues found and fixed

1. Rule-table load bug for ignore rules (runtime binding failure)
- Problem: `rule_ignore_merchant` insert SQL required 3 bindings (`merchant_key`, `reason`, `updated_at`) but code supplied only 2.
- Impact: loading any ignore rules could fail at runtime.
- Fix: pass `updated_at` timestamp for ignore inserts.
- File: `src/rules/index.ts`

2. `sync all` could mask invalid user arguments
- Problem: `sync all` caught all stage errors and continued, so user input errors could be hidden behind downstream config/auth errors.
- Fix: invalid-argument `AppError` now short-circuits immediately.
- File: `src/commands/sync.ts`

3. `sync all` prevalidation gaps
- Problem: `--days`/`--since` were not normalized up-front for all-stage runs.
- Fix: added upfront normalization in `runSyncAll` and propagated normalized options to stage calls.
- File: `src/commands/sync.ts`

4. CLI option merge bug with duplicate parent/subcommand options
- Problem: merge logic could overwrite user-provided parent option values with subcommand defaults.
- Impact: values like `sync all --days -2` could be silently ignored.
- Fix: merge now respects Commander option value source and avoids default-value clobbering.
- File: `src/cli.ts`

5. Email initial-cursor behavior when backfill finds zero messages
- Problem: first run could set cursor `last_uid=0`, causing next run to scan from UID 1 and defeat cursor-driven incrementality.
- Fix: on first empty backfill window, cursor now anchors to mailbox max UID.
- File: `src/ingest/email.ts`

6. Email logical dedupe gap within same sync batch
- Problem: canonical dedupe looked only at persisted DB rows; duplicates in same batch could get distinct canonical IDs.
- Fix: added in-memory logical dedupe map keyed by `message_id_hash + sender_domain + 10-min bucket`.
- File: `src/ingest/email.ts`

7. Scheduled-transaction prior key mismatch under aliases
- Problem: scheduled payee key normalization did not leverage alias mapping, reducing scheduled prior effectiveness.
- Fix: scheduled payee keys now run through `merchantKey` and alias normalization.
- File: `src/derive/recurring.ts`

8. Email amount parser missed plain 4+ digit values without commas
- Problem: regex preferred grouped amounts and could miss values like `$1000.00`.
- Fix: broadened amount regex to accept plain digit sequences as well.
- File: `src/ingest/email.ts`

9. Config/rules JSON parse failures surfaced as generic unhandled errors
- Problem: malformed JSON in config/rules produced non-actionable runtime failures.
- Fix: explicit `CONFIG_PARSE_FAILED` / `RULES_PARSE_FAILED` `AppError` with path and cause details.
- File: `src/config.ts`

### 18.2 Additional tests added

- `test/rules-load.test.ts`
  - verifies rules load path for alias/ignore/force without binding/runtime errors.
- `test/cli-validation.test.ts` extended
  - asserts `sync all --days -2` fails with invalid-argument semantics before config/auth paths.

### 18.3 Verification after pass #2

- `bun x tsc --noEmit` -> pass
- `bun test` -> pass (`12` passed, `0` failed)

## 19) Fresh-Eyes QA Pass #3 (2026-02-26)

A third pass focused on strict input parsing, malformed local file handling, and subtle IMAP incrementality edge cases.

### 19.1 Issues found and fixed

1. Calendar-invalid dates were accepted
- Problem: date parsing accepted values like `2026-02-30` due JS date rollover behavior.
- Fix: strict `YYYY-MM-DD` parser now validates round-trip year/month/day.
- File: `src/utils/time.ts`

2. Empty setup inputs were silently defaulted
- Problem: empty strings for fields like `--folders` were falling back via `||` defaulting.
- Fix: switched to explicit trim/nullish behavior and added non-empty validation for setup inputs.
- File: `src/commands/setup.ts`

3. Numeric option parsing accepted partial values
- Problem: values like `12abc` could partially parse.
- Fix: parsers now return `NaN` for non-strict numeric input; validators then emit structured invalid-arg errors.
- File: `src/cli.ts`

4. NaN error details serialized as `null`
- Problem: JSON error details obscured invalid numeric inputs.
- Fix: validation details now serialize NaN explicitly as `"NaN"`.
- Files: `src/utils/validate.ts`, `src/commands/report.ts`

5. Config/rules valid-JSON but invalid-shape cases were under-validated
- Problem: non-object JSON and malformed rule structures could cause confusing downstream failures.
- Fix: added shape validation and sanitation for rule arrays/maps.
- File: `src/config.ts`

6. IMAP incremental fetch could request invalid UID ranges
- Problem: when cursor already at mailbox max UID, fetch request could still be attempted.
- Fix: guard fetch calls so incrementals run only when `startUid <= mailboxMaxUid`.
- File: `src/ingest/email.ts`

### 19.2 Tests added/updated

- `test/cli-validation.test.ts` expanded:
  - impossible calendar date rejection (`2026-02-30`)
  - empty folders rejection
  - partial integer/float value rejection
- `test/config-load.test.ts` added:
  - rejects non-object config JSON
  - rejects non-object rules JSON
  - sanitizes malformed rule entries

### 19.3 Verification

- `bun x tsc --noEmit` -> pass
- `bun test` -> pass (`19` passed, `0` failed)

## 20) Fresh-Eyes QA Pass #4 (2026-02-26)

A fourth pass focused on diagnostic correctness and runtime side effects.

### 20.1 Issues found and fixed

1. `doctor` mutated state on read-only checks
- Problem: running `doctor` on a fresh state-dir created `config.json`, `rules.json`, and SQLite files, producing misleading existence checks and side effects.
- Fix:
  - added runtime mode to skip state initialization for diagnostics
  - added existing-db-only opening path (readonly)
  - wired `doctor` to use non-mutating runtime mode
- Files: `src/runtime.ts`, `src/db/index.ts`, `src/cli.ts`

2. `doctor` could crash on non-fintrack DB schema
- Problem: direct queries to `schema_version` / `sync_state` tables could throw for malformed or foreign DB files.
- Fix: wrapped DB diagnostic queries in guarded checks that emit warning checks instead of hard failure.
- File: `src/doctor.ts`

3. Config normalization robustness
- Problem: config loader accepted malformed typed fields too permissively and could propagate unsafe values.
- Fix:
  - added normalization/sanitation for currency, timezone, parser version, ynab/email sections
  - introduced readonly config loader path for non-mutating runtime
- File: `src/config.ts`

### 20.2 Tests added/updated

- `test/cli-smoke.test.ts` expanded:
  - asserts `doctor` does not create artifacts in a new state directory
- `test/config-load.test.ts` expanded:
  - asserts malformed config fields normalize safely to defaults/undefined sections

### 20.3 Verification

- `bun x tsc --noEmit` -> pass
- `bun test` -> pass (`21` passed, `0` failed)
