import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const platformExpressRequire = createRequire(
  apiRequire.resolve("@nestjs/platform-express/package.json"),
);
const expressRequire = createRequire(platformExpressRequire.resolve("express/package.json"));
const bodyParser = expressRequire("body-parser");
const qs = expressRequire("qs");

test("parser behavior tests resolve the current production dependency graph", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  assert.equal(source.includes(["node_modules", ".pnpm"].join("/")), false);
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
