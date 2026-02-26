import { EXIT } from "../constants";
import { AppError } from "../errors";
import { parseIsoDate, parseYearMonth } from "./time";

export const requireIsoDate = (flagName: string, value: string): string => {
  try {
    parseIsoDate(value);
    return value;
  } catch {
    throw new AppError(`${flagName} must be in YYYY-MM-DD format`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "INVALID_DATE_FORMAT",
      details: { flagName, value },
    });
  }
};

export const requireYearMonth = (flagName: string, value: string): string => {
  try {
    parseYearMonth(value);
    return value;
  } catch {
    throw new AppError(`${flagName} must be in YYYY-MM format`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "INVALID_MONTH_FORMAT",
      details: { flagName, value },
    });
  }
};

export const requireIntegerInRange = (
  flagName: string,
  value: number,
  options: { min?: number; max?: number }
): number => {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(`${flagName} must be an integer between ${min} and ${max}`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "INVALID_INTEGER_RANGE",
      details: { flagName, value, min, max },
    });
  }

  return value;
};

export const requireOneOf = <T extends string>(flagName: string, value: string, allowed: T[]): T => {
  if (!allowed.includes(value as T)) {
    throw new AppError(`${flagName} must be one of: ${allowed.join(", ")}`, {
      exitCode: EXIT.INVALID_ARGS,
      code: "INVALID_ENUM_VALUE",
      details: { flagName, value, allowed },
    });
  }
  return value as T;
};
