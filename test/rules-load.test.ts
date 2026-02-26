import { afterEach, describe, expect, test } from "bun:test";
import { createTestDb, type TestDbHandle } from "./helpers";
import { loadRulesIntoTables } from "../src/rules";

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("loadRulesIntoTables", () => {
  test("loads alias/ignore/force entries without binding errors", async () => {
    handle = await createTestDb();
    const { db } = handle;

    const index = loadRulesIntoTables(db, {
      aliases: {
        "spotify usa": "Spotify",
      },
      ignore: [
        { merchant: "internal transfer", reason: "non spend" },
      ],
      force: [
        { merchant: "icloud", reason: "known recurring" },
      ],
    });

    expect(index.aliasByRawKey.get("spotify usa")).toBe("Spotify");
    expect(index.ignore.has("internal transfer")).toBe(true);
    expect(index.force.has("icloud")).toBe(true);
  });
});
