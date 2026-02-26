import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (args: string[]) => {
  const stateDir = mkdtempSync(join(tmpdir(), "fintrack-cli-validate-"));
  return Bun.spawnSync(["bun", "run", "src/cli.ts", ...args, "--state-dir", stateDir], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
};

describe("CLI validation", () => {
  test("rejects invalid month format", () => {
    const proc = run(["report", "spend", "--month", "bad"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_MONTH_FORMAT");
  });

  test("rejects negative upcoming days", () => {
    const proc = run(["report", "upcoming", "--days", "-5"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_INTEGER_RANGE");
  });

  test("rejects invalid --since even when YNAB is unconfigured", () => {
    const proc = run(["sync", "ynab", "--since", "not-a-date"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_DATE_FORMAT");
  });

  test("rejects impossible calendar date for --since", () => {
    const proc = run(["sync", "ynab", "--since", "2026-02-30"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_DATE_FORMAT");
  });

  test("rejects invalid sync-all days before source config checks", () => {
    const proc = run(["sync", "all", "--days", "-2"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_INTEGER_RANGE");
  });

  test("rejects imap port outside range", () => {
    const proc = run([
      "setup",
      "email",
      "--imap-user",
      "user@example.com",
      "--imap-pass-cmd",
      "echo pass",
      "--imap-port",
      "70000",
      "--dry-run",
    ]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_INTEGER_RANGE");
  });

  test("rejects empty folders list", () => {
    const proc = run([
      "setup",
      "email",
      "--imap-user",
      "user@example.com",
      "--imap-pass-cmd",
      "echo pass",
      "--folders",
      "",
      "--no-probe-bridge",
      "--dry-run",
    ]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("EMAIL_SETUP_FOLDERS_EMPTY");
  });

  test("rejects partial integer values for numeric flags", () => {
    const proc = run(["report", "upcoming", "--days", "12abc"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_INTEGER_RANGE");
  });

  test("rejects partial float values for numeric flags", () => {
    const proc = run(["report", "upcoming", "--min-confidence", "0.5abc"]);
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("INVALID_CONFIDENCE");
  });
});
