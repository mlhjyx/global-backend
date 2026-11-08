// Unit tests for the paired RR1/RR3 reporter (node:test only).
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeReplyRates,
  formatReplyStatement,
  validateReplyStatement,
} from "./reply-rate.mjs";

function documentOf(...strata) {
  return { window: { start: "2026-10-09", end: "2026-11-08" }, strata };
}

const BASE = {
  key: "DE|zerobounce|google",
  sent: 1000,
  skipped: 10,
  internal: 5,
  duplicateRetries: 3,
  delivered: 950,
  unknown: 20,
  replies: 5,
  eHat: 0.98,
};

test("RR1 uses eligible sends and RR3 weights unknown by ê", () => {
  const result = computeReplyRates(documentOf(BASE));
  assert.equal(result.eligibleSends, 982);
  assert.equal(result.delivered, 950);
  assert.ok(Math.abs(result.adjustedUnknown - 19.6) < 1e-9);
  assert.ok(Math.abs(result.rr1 - 5 / 982) < 1e-12);
  assert.ok(Math.abs(result.rr3 - 5 / 969.6) < 1e-12);
});

test("multiple strata aggregate counts before dividing", () => {
  const second = { ...BASE, key: "FR|zerobounce|outlook", sent: 500, skipped: 0, internal: 0, duplicateRetries: 0, delivered: 480, unknown: 0, replies: 3, eHat: undefined };
  const result = computeReplyRates(documentOf(BASE, second));
  assert.equal(result.eligibleSends, 1482);
  assert.equal(result.uniqueHumanReplies, 8);
  assert.ok(Math.abs(result.rr3 - 8 / (950 + 480 + 19.6)) < 1e-12);
});

test("unknown deliveries without ê are rejected (RR3 not computable)", () => {
  const { eHat, ...noEhat } = BASE;
  assert.throws(() => computeReplyRates(documentOf(noEhat)), /no eHat/);
});

test("impossible counts are rejected", () => {
  assert.throws(() => computeReplyRates(documentOf({ ...BASE, replies: 99999 })), /replies exceed/);
  assert.throws(
    () => computeReplyRates(documentOf({ ...BASE, sent: 5, skipped: 10 })),
    /exclusions exceed sent/,
  );
  assert.throws(() => computeReplyRates({ strata: [] }), /non-empty/);
});

test("the formatted statement always carries both RR1 and RR3", () => {
  const statement = formatReplyStatement(computeReplyRates(documentOf(BASE)));
  const validation = validateReplyStatement(statement);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.match(statement, /RR1 0\.51%/);
  assert.match(statement, /RR3 0\.52%/);
  assert.match(statement, /5\/982 发送/);
  assert.match(statement, /5\/950 投递/);
});

test("single-caliber or bare statements fail validation", () => {
  const onlyRr1 = "回复率：RR1 0.42%（18/4,286 发送）";
  const onlyRr3 = "回复率：RR3 0.58%（18/3,102 投递）";
  const bareNumbers = "回复率：RR1 0.42%；RR3 0.58%";
  assert.equal(validateReplyStatement(onlyRr1).ok, false);
  assert.equal(validateReplyStatement(onlyRr3).ok, false);
  assert.equal(validateReplyStatement(bareNumbers).ok, false);
  const errors = validateReplyStatement(onlyRr1).errors;
  assert.ok(errors.includes("RR3_MISSING_OR_BARE"));
});
