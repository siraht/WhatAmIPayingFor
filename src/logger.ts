const write = (level: string, message: string, details?: unknown): void => {
  const stamp = new Date().toISOString();
  if (details === undefined) {
    process.stderr.write(`[${stamp}] ${level} ${message}\n`);
    return;
  }
  process.stderr.write(`[${stamp}] ${level} ${message} ${JSON.stringify(details)}\n`);
};

export class Logger {
  constructor(private readonly verbose: boolean) {}

  info(message: string, details?: unknown): void {
    write("INFO", message, details);
  }

  warn(message: string, details?: unknown): void {
    write("WARN", message, details);
  }

  error(message: string, details?: unknown): void {
    write("ERROR", message, details);
  }

  debug(message: string, details?: unknown): void {
    if (!this.verbose) {
      return;
    }
    write("DEBUG", message, details);
  }
}
