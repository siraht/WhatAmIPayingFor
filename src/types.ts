import type { ExitCode } from "./constants";

export interface YnabConfig {
  tokenEnv: string;
  budgetId: string;
  budgetSelector: string;
  lastValidatedAt?: string;
}

export interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassCmd: string;
  folders: string[];
  probeBridge: boolean;
  accountLabel: string;
  lastValidatedAt?: string;
}

export interface FintrackConfig {
  version: 1;
  timezone: string;
  currency: string;
  parserVersion: string;
  ynab?: YnabConfig;
  email?: EmailConfig;
}

export interface GlobalFlags {
  json: boolean;
  noInput: boolean;
  config?: string;
  stateDir?: string;
  verbose: boolean;
}

export interface RuntimePaths {
  stateDir: string;
  configPath: string;
  dbPath: string;
  rulesPath: string;
}

export interface CommandResult<T = unknown> {
  exitCode?: ExitCode;
  data?: T;
  warnings?: string[];
  message?: string;
}

export interface SyncCursor {
  [key: string]: string | number | boolean | null;
}

export interface SyncStateRow {
  source: string;
  scope: string;
  cursorJson: string;
  updatedAt: string;
}

export interface MatchReason {
  code: string;
  weight: number;
  note?: string;
}

export interface RecurringReason {
  code: string;
  note?: string;
}
