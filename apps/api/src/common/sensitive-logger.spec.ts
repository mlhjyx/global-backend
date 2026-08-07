import { ConsoleLogger, Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSensitiveLogger, SensitiveLogger } from "./sensitive-logger";

describe("SensitiveLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("digests arbitrary Error messages, stacks and code values at the logger boundary", () => {
    const error = Object.assign(
      new Error("Jane Doe appeared in a provider prompt fragment"),
      { code: "ACME" },
    );
    const delegate = vi
      .spyOn(ConsoleLogger.prototype, "error")
      .mockImplementation(() => undefined);

    new SensitiveLogger().error(error);

    expect(delegate).toHaveBeenCalledTimes(1);
    const rendered = JSON.stringify(delegate.mock.calls[0]);
    expect(rendered).toContain("messageDigest");
    expect(rendered).toContain("codeDigest");
    expect(rendered).not.toContain("Jane Doe");
    expect(rendered).not.toContain("prompt fragment");
    expect(rendered).not.toContain("ACME");
    expect(rendered).not.toContain("stack");
  });

  it("applies the same boundary to every Nest log level and optional parameter", () => {
    const logger = new SensitiveLogger();
    const methods = [
      "log",
      "error",
      "warn",
      "debug",
      "verbose",
      "fatal",
    ] as const;

    for (const method of methods) {
      const delegate = vi
        .spyOn(ConsoleLogger.prototype, method)
        .mockImplementation(() => undefined);
      logger[method](
        "contact jane@example.com token=private",
        new Error("Jane Doe appeared in a private prompt"),
      );
      const rendered = JSON.stringify(delegate.mock.calls.at(-1));
      expect(rendered).toContain("[redacted-email]");
      expect(rendered).toContain("messageDigest");
      expect(rendered).not.toContain("jane@example.com");
      expect(rendered).not.toContain("Jane Doe");
      expect(rendered).not.toContain("private prompt");
    }
  });

  it("installs one recursive boundary over every direct console method", () => {
    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      debug: console.debug,
      info: console.info,
    };
    const sinks = {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    };
    Object.assign(console, sinks);
    const override = vi
      .spyOn(Logger, "overrideLogger")
      .mockImplementation(() => undefined);

    try {
      installSensitiveLogger();
      for (const method of Object.keys(sinks) as (keyof typeof sinks)[]) {
        console[method](
          new Error("Jane Doe appeared in a private provider response"),
        );
        const rendered = JSON.stringify(sinks[method].mock.calls.at(-1));
        expect(rendered).toContain("messageDigest");
        expect(rendered).not.toContain("Jane Doe");
        expect(rendered).not.toContain("private provider response");
      }
      expect(override).toHaveBeenCalledTimes(1);
      installSensitiveLogger();
      expect(override).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(console, originalConsole);
    }
  });
});
