import { AppError } from "./errors";
import type { GlobalFlags, RuntimePaths, FintrackConfig } from "./types";
import { Logger } from "./logger";
import { buildRuntimePaths, ensureStateDir } from "./utils/paths";
import { ensureRulesFile, loadConfig, loadConfigReadonly } from "./config";
import { openDatabase, openExistingDatabase, type FintrackDb } from "./db";

export interface RuntimeContext {
  flags: GlobalFlags;
  paths: RuntimePaths;
  logger: Logger;
  config: FintrackConfig;
  db: FintrackDb | null;
}

export const createRuntime = async (
  flags: GlobalFlags,
  options?: { needsDb?: boolean; initializeState?: boolean; openExistingDbOnly?: boolean }
): Promise<RuntimeContext> => {
  const paths = buildRuntimePaths(flags.stateDir, flags.config);
  const logger = new Logger(flags.verbose);

  const initializeState = options?.initializeState !== false;
  if (initializeState) {
    await ensureStateDir(paths.stateDir);
    await ensureRulesFile(paths);
  }
  const config = initializeState ? await loadConfig(paths) : await loadConfigReadonly(paths);

  let db: FintrackDb | null = null;
  if (options?.needsDb !== false) {
    if (options?.openExistingDbOnly) {
      db = openExistingDatabase(paths.dbPath);
    } else {
      db = await openDatabase(paths.dbPath);
    }
  }

  return {
    flags,
    paths,
    logger,
    config,
    db,
  };
};

export const requireDb = (db: FintrackDb | null): FintrackDb => {
  if (!db) {
    throw new AppError("Database is not initialized", {
      code: "DB_NOT_AVAILABLE",
    });
  }
  return db;
};

export const closeRuntime = (ctx: RuntimeContext): void => {
  ctx.db?.close();
};
