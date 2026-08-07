import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LEAD_QUALITY_LABELS,
  type LeadQualityLabel,
} from "./lead-quality-label.domain";

export type LeadQualityLabelOperatorStatus = "LABEL_POSTED" | "ACKED";

export interface LeadQualityLabelOperatorState {
  eventId: string;
  status: LeadQualityLabelOperatorStatus;
  label: LeadQualityLabel;
  labelReceiptId: string;
  labelPostedAt: string;
  ackedAt: string | null;
  updatedAt: string;
}

export interface LeadQualityLabelOperatorStateStore {
  get(
    eventId: string,
  ):
    | LeadQualityLabelOperatorState
    | null
    | Promise<LeadQualityLabelOperatorState | null>;
  set(state: LeadQualityLabelOperatorState): void | Promise<void>;
}

interface StateFile {
  version: 1;
  events: Record<string, LeadQualityLabelOperatorState>;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STATE_BYTES = 1_048_576;
const MAX_STATE_EVENTS = 10_000;

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && Number.isFinite(new Date(value).getTime())
  );
}

function isState(value: unknown): value is LeadQualityLabelOperatorState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.eventId === "string" &&
    UUID_V4.test(state.eventId) &&
    (state.status === "LABEL_POSTED" || state.status === "ACKED") &&
    typeof state.label === "string" &&
    (LEAD_QUALITY_LABELS as readonly string[]).includes(state.label) &&
    typeof state.labelReceiptId === "string" &&
    UUID_V4.test(state.labelReceiptId) &&
    isTimestamp(state.labelPostedAt) &&
    (state.ackedAt === null || isTimestamp(state.ackedAt)) &&
    isTimestamp(state.updatedAt) &&
    ((state.status === "LABEL_POSTED" && state.ackedAt === null) ||
      (state.status === "ACKED" && state.ackedAt !== null))
  );
}

/** Minimal local receipt state; it never stores tokens, event payloads, or contact fields. */
export class FileLeadQualityLabelOperatorStateStore implements LeadQualityLabelOperatorStateStore {
  constructor(private readonly path: string) {}

  get(eventId: string): LeadQualityLabelOperatorState | null {
    return this.read().events[eventId] ?? null;
  }

  set(state: LeadQualityLabelOperatorState): void {
    if (!isState(state)) throw new Error("operator state is invalid");
    this.ensureDedicatedDirectory();
    const release = this.acquireLock();
    try {
      const current = this.readFile();
      this.assertTransition(current.events[state.eventId] ?? null, state);
      const next: StateFile = {
        version: 1,
        events: { ...current.events, [state.eventId]: { ...state } },
      };
      if (Object.keys(next.events).length > MAX_STATE_EVENTS) {
        throw new Error("operator state event limit exceeded");
      }
      const content = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) {
        throw new Error("operator state file size limit exceeded");
      }
      this.atomicWrite(content);
    } finally {
      release();
    }
  }

  private read(): StateFile {
    if (!existsSync(this.path)) return { version: 1, events: {} };
    this.ensureDedicatedDirectory();
    return this.readFile();
  }

  private readFile(): StateFile {
    if (!existsSync(this.path)) return { version: 1, events: {} };
    const metadata = lstatSync(this.path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("operator state path must be a regular file");
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error("operator state file must be owned by the current user");
    }
    if ((metadata.mode & 0o777) !== 0o600)
      throw new Error("operator state file permissions must be 0600");
    if (metadata.size > MAX_STATE_BYTES)
      throw new Error("operator state file size limit exceeded");

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("operator state file is invalid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("operator state file is invalid");
    }
    const file = parsed as { version?: unknown; events?: unknown };
    if (
      file.version !== 1 ||
      typeof file.events !== "object" ||
      file.events === null ||
      Array.isArray(file.events)
    ) {
      throw new Error("operator state file schema is invalid");
    }
    const entries = Object.entries(file.events);
    if (entries.length > MAX_STATE_EVENTS)
      throw new Error("operator state event limit exceeded");
    if (
      entries.some(
        ([eventId, value]) =>
          !UUID_V4.test(eventId) ||
          !isState(value) ||
          value.eventId !== eventId,
      )
    ) {
      throw new Error("operator state event entry is invalid");
    }
    return { version: 1, events: Object.fromEntries(entries) };
  }

  private ensureDedicatedDirectory(): void {
    const directory = dirname(this.path);
    if (!existsSync(directory))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "operator state directory must be a dedicated regular directory",
      );
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error(
        "operator state directory must be owned by the current user",
      );
    }
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error("operator state directory permissions must be 0700");
    }
  }

  private acquireLock(): () => void {
    const lockPath = `${this.path}.lock`;
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch {
      throw new Error("operator state is locked by another process");
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`, {
        encoding: "utf8",
      });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return () => {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    };
  }

  private assertTransition(
    previous: LeadQualityLabelOperatorState | null,
    next: LeadQualityLabelOperatorState,
  ): void {
    if (!previous) {
      if (next.status !== "LABEL_POSTED")
        throw new Error("initial operator state must be LABEL_POSTED");
      return;
    }
    if (previous.status !== "LABEL_POSTED" || next.status !== "ACKED") {
      throw new Error(
        "operator state transition must be LABEL_POSTED to ACKED",
      );
    }
    if (
      previous.eventId !== next.eventId ||
      previous.label !== next.label ||
      previous.labelReceiptId !== next.labelReceiptId ||
      previous.labelPostedAt !== next.labelPostedAt ||
      next.ackedAt === null
    ) {
      throw new Error(
        "operator ACKED transition cannot rewrite the label receipt",
      );
    }
  }

  private atomicWrite(content: string): void {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let fileDescriptor: number | null = null;
    try {
      fileDescriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(fileDescriptor, content, { encoding: "utf8" });
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = null;
      renameSync(temporaryPath, this.path);

      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (fileDescriptor !== null) closeSync(fileDescriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }
}
