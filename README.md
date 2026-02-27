# fintrack

Terminal-first finance tracking CLI for recurring transactions, spend breakdowns, and upcoming charge forecasts.

MVP sources:
- YNAB API transactions + scheduled transactions (money movement source of truth)
- Proton Mail Bridge IMAP purchase emails (enrichment evidence only, raw body not persisted)

## Requirements

- Bun 1.2+
- A writable state directory (default `~/.fintrack`)
- Optional for live sync:
  - YNAB personal access token
  - Proton Mail Bridge IMAP credentials

## Install / Run

```bash
bun install
bun run src/cli.ts --help
# or
./bin/fintrack --help
```

## Environment (.env)

```bash
cp .env.example .env
```

`.env` is ignored by git. Use it for secrets like `YNAB_TOKEN` and optional `FINTRACK_IMAP_PASS`.

## Quickstart

```bash
# Configure YNAB
fintrack setup ynab --token-env YNAB_TOKEN --budget-id last-used

# Configure Proton Bridge IMAP
fintrack setup email \
  --imap-host 127.0.0.1 \
  --imap-port 1143 \
  --imap-user "<bridge-user>" \
  --imap-pass-cmd "pass show fintrack/bridge"

# or use .env-backed password:
fintrack setup email \
  --imap-user "<bridge-user>" \
  --imap-pass-cmd "printf '%s' \"$FINTRACK_IMAP_PASS\""

# Sync all sources then recompute derived layers
fintrack sync all --days 365

# YNAB bootstrap window defaults to the last 6 months.
# Override for deeper history when needed:
fintrack sync ynab --since 2024-01-01

# Reports
fintrack report spend --month 2026-02 --group-by merchant
fintrack report subscriptions --month 2026-02 --explain
fintrack report upcoming --days 30 --visual

# Health checks
fintrack doctor --json
```

## Command Tree

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

`fintrack sync` without a subcommand behaves as `fintrack sync all`.

## Global Flags

- `--json`
- `--no-input`
- `--config <path>`
- `--state-dir <path>`
- `--verbose`

## Exit Codes

- `0` success
- `1` runtime failure
- `2` invalid arguments
- `3` auth failure
- `4` upstream failure/rate-limit exhaustion
- `5` partial success

## Spend JSON Units

`report spend --json` includes:
- `totalMinor` (integer minor units, e.g. cents)
- `totalMajor` / `totalUsd` (decimal major units)
- `totalDisplay` (currency-formatted string)

Rows include matching fields (`total_minor`, `totalMajor`, `totalUsd`, `totalDisplay`) to reduce unit ambiguity.

## Privacy

Stored email data is limited to extracted evidence fields and operational metadata:
- stable dedupe IDs/hashes
- sender domain / timestamp / parser info
- extracted item name + price (if detected)

Raw body content and attachments are not persisted.

## Rules File

Rules are loaded from `<state-dir>/rules.json` and synchronized into SQLite rule tables.

Default template:

```json
{
  "aliases": {
    "adobe systems": "Adobe"
  },
  "ignore": [
    { "merchant": "internal transfer", "reason": "non-spend flow" }
  ],
  "force": [
    { "merchant": "icloud", "reason": "known subscription" }
  ]
}
```

## Testing

```bash
bun x tsc --noEmit
bun test
```

Current automated tests cover:
- matching tie-break determinism
- recurring monthly detection and short-month prediction clamp
- migration forward-only behavior on DB reopen
- CLI doctor smoke test (JSON mode + exit code behavior)

## Notes Without API Keys

You can still run local setup, doctor, migrations, and report plumbing in an empty DB.
Live `sync ynab` and `sync email` require credentials/config and will return actionable auth/config errors when missing.
