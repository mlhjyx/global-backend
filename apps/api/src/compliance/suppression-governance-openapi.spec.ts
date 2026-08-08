import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OPERATIONS = [
  ["/api/v1/suppressions", "post", "201"],
  ["/api/v1/suppressions", "get", "200"],
  ["/api/v1/suppressions/{id}", "delete", "200"],
  ["/api/v1/suppressions/{id}/release-requests", "post", "202"],
] as const;

describe("suppression governance OpenAPI availability", () => {
  it.each(OPERATIONS)(
    "publishes %s %s with compliance scope and the implemented success schema",
    (path, method, successStatus) => {
      const document = JSON.parse(
        readFileSync(
          resolve(
            process.cwd(),
            "../../packages/contracts/openapi/openapi.json",
          ),
          "utf8",
        ),
      ) as {
        paths: Record<
          string,
          Record<
            string,
            {
              description?: string;
              responses: Record<string, unknown>;
              "x-required-scopes"?: string[];
              "x-runtime-availability"?: string;
            }
          >
        >;
      };
      const operation = document.paths[path]?.[method];

      expect(operation).toBeDefined();
      expect(operation?.["x-required-scopes"]).toEqual([
        "compliance:manage",
      ]);
      expect(operation?.["x-runtime-availability"]).toBeUndefined();
      expect(operation?.description).not.toContain("pending");
      expect(operation?.responses).not.toHaveProperty("503");
      expect(operation?.responses).toHaveProperty("401");
      expect(operation?.responses).toHaveProperty("403");
      expect(operation?.responses).toHaveProperty(successStatus);
    },
  );
});
