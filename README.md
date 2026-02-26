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

# Sync all sources then recompute derived layers
fintrack sync all --days 365

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
