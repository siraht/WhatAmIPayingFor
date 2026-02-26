import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadRulesFile } from "../src/config";
import { DEFAULT_CONFIG_NAME, DEFAULT_DB_NAME, DEFAULT_RULES_NAME } from "../src/constants";
import { AppError } from "../src/errors";

let dir: string | null = null;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

const makePaths = () => {
  dir = mkdtempSync(join(tmpdir(), "fintrack-config-test-"));
  return {
    stateDir: dir,
    configPath: join(dir, DEFAULT_CONFIG_NAME),
    dbPath: join(dir, DEFAULT_DB_NAME),
    rulesPath: join(dir, DEFAULT_RULES_NAME),
  };
};

describe("config loaders", () => {
  test("rejects non-object config JSON", async () => {
    const paths = makePaths();
    writeFileSync(paths.configPath, "[]\n", "utf8");

    try {
      await loadConfig(paths);
      expect.unreachable("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_INVALID_SHAPE");
    }
  });

  test("rejects non-object rules JSON", async () => {
    const paths = makePaths();
    writeFileSync(paths.rulesPath, "[]\n", "utf8");

    try {
      await loadRulesFile(paths);
      expect.unreachable("expected loadRulesFile to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("RULES_INVALID_SHAPE");
    }
  });

  test("sanitizes malformed rule entries", async () => {
    const paths = makePaths();
    writeFileSync(
      paths.rulesPath,
      JSON.stringify(
        {
          aliases: { ok: "Alias", bad: 42 },
          ignore: [{ merchant: "keep" }, { merchant: 1 }, "bad"],
          force: [{ merchant: "force", reason: 7 }, null],
        },
        null,
        2
      ),
      "utf8"
    );

    const rules = await loadRulesFile(paths);
    expect(rules.aliases).toEqual({ ok: "Alias" });
    expect(rules.ignore).toEqual([{ merchant: "keep", reason: undefined }]);
    expect(rules.force).toEqual([{ merchant: "force", reason: undefined }]);
  });
});
