import { ConsoleLogger, Logger, type LoggerService } from "@nestjs/common";
import {
  scrubSensitiveData,
  scrubSensitiveText,
} from "./sensitive-data-scrubber";

function scrubLogValue(value: unknown): unknown {
  return typeof value === "string"
    ? scrubSensitiveText(value)
    : scrubSensitiveData(value);
}

/** Nest-wide logger boundary. Call once before creating any app/worker service. */
export class SensitiveLogger implements LoggerService {
  private readonly delegate = new ConsoleLogger();

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.log(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.error(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.warn(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.debug(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.verbose(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.delegate.fatal(
      scrubLogValue(message),
      ...optionalParams.map(scrubLogValue),
    );
  }
}

let installed = false;

function installSensitiveConsoleBoundary(): void {
  const originals = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
  };
  const safe = (values: unknown[]): unknown[] => values.map(scrubLogValue);
  console.log = (...values: unknown[]) => originals.log(...safe(values));
  console.error = (...values: unknown[]) => originals.error(...safe(values));
  console.warn = (...values: unknown[]) => originals.warn(...safe(values));
  console.debug = (...values: unknown[]) => originals.debug(...safe(values));
  console.info = (...values: unknown[]) => originals.info(...safe(values));
}

export function installSensitiveLogger(): void {
  if (installed) return;
  installSensitiveConsoleBoundary();
  Logger.overrideLogger(new SensitiveLogger());
  installed = true;
}
