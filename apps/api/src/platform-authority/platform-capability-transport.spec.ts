import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityTransport } from "./platform-capability-transport";
const nonce = "a".repeat(32);
const config = () => ({
  endpoint: "https://growthos.example.test/internal/capabilities",
  backendSha: "b".repeat(40),
  growthosSha: "c".repeat(40),
  policyDigest: "d".repeat(64),
  schedules: [
    {
      scheduleId: "acq-sweep",
      workflowType: "acquisitionSweepWorkflow",
      taskQueue: "understanding",
      mode: "ENABLED",
    },
  ],
});
const serviceToken = () =>
  Promise.resolve(["test", "service", "signature"].join("."));
const signal = () => new AbortController().signal;
const response = (body = "header.payload.signature") =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/jose" },
  });
afterEach(() => vi.useRealTimers());
describe("bounded authenticated capability transport", () => {
  it("pins destination and service credentials, sends exact nonce and identities", async () => {
    const fetcher = vi.fn(async () => response());
    const options = config();
    const transport = createCapabilityTransport(options, serviceToken, fetcher);
    options.endpoint = "https://attacker.test";
    options.backendSha = "e".repeat(40);
    expect(await transport(nonce, signal())).toBe("header.payload.signature");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://growthos.example.test/internal/capabilities");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
    });
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer test.service.signature",
    );
    expect(JSON.parse(request.body as string)).toMatchObject({
      nonce,
      backendSha: "b".repeat(40),
      namespace: "platform-automation",
    });
  });
  it.each([
    "http://outside.example.test/x",
    "https://u:p@example.test/x",
    "https://example.test/x?q=a",
    "https://example.test/x#fragment",
    "file:///tmp/x",
  ])("rejects unsafe configured endpoint %s", (endpoint) => {
    expect(() =>
      createCapabilityTransport(
        { ...config(), endpoint },
        serviceToken,
        vi.fn(),
      ),
    ).toThrow("PLATFORM_CAPABILITY_TRANSPORT_INVALID");
  });
  it("allows a configured literal loopback HTTP endpoint", async () => {
    const transport = createCapabilityTransport(
      { ...config(), endpoint: "http://127.0.0.1:18081/internal/capabilities" },
      serviceToken,
      async () => response(),
    );
    await expect(transport(nonce, signal())).resolves.toBe(
      "header.payload.signature",
    );
  });
  it.each([302, 401, 403, 404, 429, 500])(
    "rejects status %s without forwarding credentials elsewhere",
    async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response("", {
            status,
            headers: { location: "https://attacker.test" },
          }),
      );
      await expect(
        createCapabilityTransport(
          config(),
          serviceToken,
          fetcher,
        )(nonce, signal()),
      ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects invalid nonce before obtaining a service token", async () => {
    const provider = vi.fn(serviceToken);
    const fetcher = vi.fn();
    await expect(
      createCapabilityTransport(config(), provider, fetcher)("bad", signal()),
    ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
    expect(provider).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("times out a token provider that ignores abort without sending a request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    const pending = createCapabilityTransport(
      config(),
      () => new Promise(() => {}),
      fetcher,
    )(nonce, signal());
    const assertion = expect(pending).rejects.toThrow(
      "PLATFORM_CAPABILITY_UNAVAILABLE",
    );
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streamed response bytes even without content-length", async () => {
    const transport = createCapabilityTransport(
      config(),
      serviceToken,
      async () => response("x".repeat(16385)),
    );
    await expect(transport(nonce, signal())).rejects.toThrow(
      "PLATFORM_CAPABILITY_UNAVAILABLE",
    );
  });
  it("rejects wrong MIME type and non-UTF8 payload", async () => {
    const responses = [
      new Response("x", { headers: { "content-type": "application/json" } }),
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/jose" },
      }),
    ];
    for (const r of responses)
      await expect(
        createCapabilityTransport(
          config(),
          serviceToken,
          async () => r,
        )(nonce, signal()),
      ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
  });
  it("rejects already aborted requests and credential injection", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn();
    await expect(
      createCapabilityTransport(
        config(),
        serviceToken,
        fetcher,
      )(nonce, abort.signal),
    ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
    await expect(
      createCapabilityTransport(
        config(),
        async () => "bad\r\nAuthorization: leaked",
        fetcher,
      )(nonce, signal()),
    ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("bounds a hanging response stream and invokes its cancellation hook", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
    cancel,
  });
  const transport = createCapabilityTransport(
    config(),
    serviceToken,
    async () =>
      new Response(body, { headers: { "content-type": "application/jose" } }),
  );
  const pending = transport(nonce, signal());
  const assertion = expect(pending).rejects.toThrow(
    "PLATFORM_CAPABILITY_UNAVAILABLE",
  );
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
  expect(cancel).toHaveBeenCalled();
});
it("does not send after parent cancellation during token acquisition", async () => {
  let resolveToken: (value: string) => void = () => {};
  const provider = () =>
    new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
  const fetcher = vi.fn();
  const controller = new AbortController();
  const pending = createCapabilityTransport(
    config(),
    provider,
    fetcher,
  )(nonce, controller.signal);
  const assertion = expect(pending).rejects.toThrow(
    "PLATFORM_CAPABILITY_UNAVAILABLE",
  );
  controller.abort();
  resolveToken("test.service.signature");
  await assertion;
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects an origin changed by a transport and misleading length headers", async () => {
  const changed = response();
  Object.defineProperty(changed, "url", { value: "https://attacker.test/x" });
  for (const r of [
    changed,
    new Response("x", {
      headers: {
        "content-type": "application/jose",
        "content-length": "16385",
      },
    }),
    new Response("x", {
      headers: { "content-type": "application/jose", "content-length": "bad" },
    }),
  ]) {
    await expect(
      createCapabilityTransport(
        config(),
        serviceToken,
        async () => r,
      )(nonce, signal()),
    ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
  }
});
it("rejects empty or non-JWS stream output including BOM", async () => {
  for (const body of ["", "not a token", "\uFEFFheader.payload.signature"])
    await expect(
      createCapabilityTransport(config(), serviceToken, async () =>
        response(body),
      )(nonce, signal()),
    ).rejects.toThrow("PLATFORM_CAPABILITY_UNAVAILABLE");
});
it("bounds an unresponsive fetch independently of its AbortSignal handling", async () => {
  vi.useFakeTimers();
  const transport = createCapabilityTransport(
    config(),
    serviceToken,
    async () => new Promise<Response>(() => {}),
  );
  const pending = transport(nonce, signal());
  const assertion = expect(pending).rejects.toThrow(
    "PLATFORM_CAPABILITY_UNAVAILABLE",
  );
  await vi.advanceTimersByTimeAsync(3000);
  await assertion;
});
