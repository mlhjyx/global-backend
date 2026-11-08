// Unit tests for the frame-registry validator (node:test only).
import assert from "node:assert/strict";
import test from "node:test";

import { loadFrameRegistry, validateFrameRegistry } from "./frame-registry.mjs";

function validFrame(overrides = {}) {
  return {
    frameKey: "xx-test-frame",
    jurisdiction: "XX",
    name: "Test frame",
    sourceUrl: "https://example.org/frame",
    accessMode: "bulk",
    licenseId: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    redistribution: "allowed",
    updateCadence: "monthly",
    recordCountNote: "n/a",
    fieldsNote: "n/a",
    priority: 1,
    status: "DRAFT",
    pitfalls: ["none"],
    ...overrides,
  };
}

function registryOf(...frames) {
  return { schemaVersion: "frame-registry/v1", frames };
}

test("the checked-in registry passes validation with 19 jurisdictions", () => {
  const { issues, summary } = loadFrameRegistry();
  assert.deepEqual(issues, []);
  assert.equal(summary.total, 19);
  assert.equal(summary.jurisdictions.length, 19);
  assert.equal(summary.byStatus.DRAFT, 19);
});

test("a minimal valid frame passes", () => {
  const { issues } = validateFrameRegistry(registryOf(validFrame()));
  assert.deepEqual(issues, []);
});

test("duplicate frame_key is rejected", () => {
  const { issues } = validateFrameRegistry(
    registryOf(validFrame(), validFrame({ jurisdiction: "YY" })),
  );
  assert.ok(issues.some((item) => item.code === "FRAME_KEY_DUPLICATE"));
});

test("ACTIVE without licence is rejected", () => {
  const { issues } = validateFrameRegistry(
    registryOf(validFrame({ status: "ACTIVE", licenseId: "", licenseUrl: "" })),
  );
  assert.ok(issues.some((item) => item.code === "ACTIVE_WITHOUT_LICENSE"));
});

test("bad enums and URLs are rejected", () => {
  const { issues } = validateFrameRegistry(
    registryOf(
      validFrame({
        accessMode: "ftp",
        updateCadence: "hourly",
        redistribution: "sometimes",
        status: "LIVE",
        priority: 9,
        sourceUrl: "http://insecure.example",
        jurisdiction: "xx",
        frameKey: "Bad Key",
      }),
    ),
  );
  const codes = new Set(issues.map((item) => item.code));
  for (const code of [
    "ACCESS_MODE_INVALID",
    "CADENCE_INVALID",
    "REDISTRIBUTION_INVALID",
    "STATUS_INVALID",
    "PRIORITY_INVALID",
    "SOURCE_URL_INVALID",
    "JURISDICTION_INVALID",
    "FRAME_KEY_INVALID",
  ]) {
    assert.ok(codes.has(code), `expected ${code}, got ${[...codes].join(",")}`);
  }
});

test("empty registry and missing pitfalls are rejected", () => {
  const empty = validateFrameRegistry({ schemaVersion: "frame-registry/v1", frames: [] });
  assert.ok(empty.issues.some((item) => item.code === "FRAMES_EMPTY"));
  const noPitfalls = validateFrameRegistry(registryOf(validFrame({ pitfalls: [] })));
  assert.ok(noPitfalls.issues.some((item) => item.code === "PITFALLS_MISSING"));
});
