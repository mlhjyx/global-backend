import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const bodyParser = require("../node_modules/.pnpm/body-parser@1.20.6/node_modules/body-parser");
const qs = require("../node_modules/.pnpm/qs@6.15.3/node_modules/qs");

test("parser behavior tests resolve the current production dependency graph", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /node_modules\/\.pnpm/u);
  assert.match(source, /@nestjs\/platform-express/u);
});

test("body-parser rejects an invalid size limit instead of disabling enforcement", () => {
  for (const factory of [bodyParser.json, bodyParser.urlencoded, bodyParser.raw, bodyParser.text]) {
    assert.throws(
      () => factory({ limit: "definitely-invalid", extended: true }),
      /option limit "definitely-invalid" is invalid/u,
    );
  }
});

test("qs comma-array stringification safely handles nullish elements", () => {
  assert.doesNotThrow(() =>
    qs.stringify(
      { values: [null, undefined, "ok"] },
      { arrayFormat: "comma", encodeValuesOnly: true },
    ),
  );
  assert.equal(
    qs.stringify(
      { values: [null, undefined, "ok"] },
      { arrayFormat: "comma", encodeValuesOnly: true },
    ),
    "values=,,ok",
  );
});
