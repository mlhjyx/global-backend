import { describe, expect, it, vi } from "vitest";
import { bindNativeMachineCredential } from "./native-machine-connection";
import type { VerifiedMachineToken } from "../platform-authority/machine-token-verifier";

describe("Native SDK credential lifecycle", () => {
  it("clears native credentials and stops polling on expiry, rather than retaining the last bearer", async () => {
    let listener!: (credential: VerifiedMachineToken | null) => void;
    const setApiKey = vi.fn(async () => undefined);
    const stop = vi.fn();
    bindNativeMachineCredential(
      {
        currentToken: () => "verified",
        subscribe: (value) => {
          listener = value;
          return () => undefined;
        },
      },
      { setApiKey },
      stop,
    );
    listener(null);
    await Promise.resolve();
    expect(setApiKey).toHaveBeenCalledWith("");
    expect(stop).toHaveBeenCalledOnce();
  });
  it("installs the currently verified credential rather than an obsolete queued update", async () => {
    let listener!: (credential: VerifiedMachineToken | null) => void;
    let token = "first";
    const setApiKey = vi.fn(async () => undefined);
    const stop = vi.fn();
    const unsubscribe = vi.fn();
    const unbind = bindNativeMachineCredential(
      {
        currentToken: () => token,
        subscribe: (value) => {
          listener = value;
          return unsubscribe;
        },
      },
      { setApiKey },
      stop,
    );
    listener({ token: "first", expiresAt: 300, subject: "worker" });
    token = "newest";
    await new Promise((resolve) => setImmediate(resolve));
    expect(setApiKey).toHaveBeenCalledWith("newest");
    expect(stop).not.toHaveBeenCalled();
    unbind();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("fails closed exactly once if native credential installation fails", async () => {
    let listener!: (credential: VerifiedMachineToken | null) => void;
    const stop = vi.fn();
    const setApiKey = vi.fn(async () => {
      throw new Error("native unavailable");
    });
    bindNativeMachineCredential(
      {
        currentToken: () => "verified",
        subscribe: (value) => {
          listener = value;
          return () => undefined;
        },
      },
      { setApiKey },
      stop,
    );
    listener({ token: "verified", expiresAt: 300, subject: "worker" });
    await new Promise((resolve) => setImmediate(resolve));
    listener(null);
    expect(stop).toHaveBeenCalledOnce();
    expect(setApiKey).toHaveBeenLastCalledWith("");
  });
});
