import { describe, expect, it } from "vitest";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";

class Denied extends Error {}
class Unavailable extends Error {}
const { ClosedJwtObjectParser: Parser } = createStrictJwtPrimitives(
  Denied,
  Unavailable,
);

describe("closed machine JWT permission arrays", () => {
  it("reads the official permissions wire array without relaxing flat identity claims", () => {
    expect(
      new Parser('{"sub":"worker","permissions":["default:worker"]}').parse(
        ["sub", "permissions"],
        ["permissions"],
      ),
    ).toEqual({ sub: "worker", permissions: ["default:worker"] });
    expect(() =>
      new Parser('{"permissions":["default:worker"]}').parse(["permissions"]),
    ).toThrow(Denied);
  });

  it.each([
    '{"permissions":["default:worker"],"permissions":["default:admin"]}',
    '{"permissions":["default:worker"],"permiss\\u0069ons":["default:admin"]}',
    '{"permissions":[["default:worker"]]}',
    '{"permissions":["default:worker",]}',
    '{"permissions":[1]}',
    '{"permissions":[]}',
    '{"permissions":"default:worker"}',
    '{"permissions":["default:worker"],"extra":1}',
    '{"permissions":["a","b","c","d","e","f","g","h","i"]}',
  ])("rejects ambiguous or non-contract wire %s", (source) => {
    expect(() =>
      new Parser(source).parse(["permissions"], ["permissions"]),
    ).toThrow(Denied);
  });

  it("does not admit arrays on non-designated claims", () => {
    expect(() =>
      new Parser('{"sub":["worker"],"permissions":["default:worker"]}').parse(
        ["sub", "permissions"],
        ["permissions"],
      ),
    ).toThrow(Denied);
  });
});
