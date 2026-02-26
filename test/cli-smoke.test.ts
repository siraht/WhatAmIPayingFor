import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CLI smoke", () => {
  test("runs doctor in json mode with isolated state dir", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fintrack-cli-"));
    const proc = Bun.spawnSync(
      ["bun", "run", "src/cli.ts", "doctor", "--json", "--state-dir", stateDir],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(proc.exitCode).toBe(5);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.action).toBe("doctor");
    expect(payload.summary).toBeDefined();
  });

  test("doctor does not create state artifacts in a new state directory", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "fintrack-cli-"));
    const before = readdirSync(stateDir);
    expect(before.length).toBe(0);

    const proc = Bun.spawnSync(
      ["bun", "run", "src/cli.ts", "doctor", "--state-dir", stateDir, "--json"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    expect(proc.exitCode).toBe(5);
    const after = readdirSync(stateDir);
    expect(after.length).toBe(0);
  });
});
