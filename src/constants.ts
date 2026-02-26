export const APP_NAME = "fintrack";
export const APP_VERSION = "0.1.0";

export const DEFAULT_STATE_DIR = "~/.fintrack";
export const DEFAULT_CONFIG_NAME = "config.json";
export const DEFAULT_DB_NAME = "fintrack.db";
export const DEFAULT_RULES_NAME = "rules.json";

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_PARSER_VERSION = "email-parser-v1";

export const YNAB_BASE_URL = "https://api.ynab.com/v1";
export const YNAB_DEFAULT_TOKEN_ENV = "YNAB_TOKEN";

export const EMAIL_DEFAULT_HOST = "127.0.0.1";
export const EMAIL_DEFAULT_PORT = 1143;
export const EMAIL_DEFAULT_FOLDERS = ["Inbox"];

export const EXIT = {
  SUCCESS: 0,
  RUNTIME: 1,
  INVALID_ARGS: 2,
  AUTH_FAILURE: 3,
  UPSTREAM_FAILURE: 4,
  PARTIAL_SUCCESS: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
