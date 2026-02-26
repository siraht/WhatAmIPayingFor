import { EXIT, type ExitCode } from "./constants";

export class AppError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options?: { exitCode?: ExitCode; code?: string; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.exitCode = options?.exitCode ?? EXIT.RUNTIME;
    this.code = options?.code ?? "RUNTIME_ERROR";
    this.details = options?.details;
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;
