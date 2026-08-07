import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PENDING = "AUTHORIZATION_INTEGRATION_PENDING";
const OPERATIONS = [
  ["/api/v1/suppressions", "post", "201"],
  ["/api/v1/suppressions", "get", "200"],
  ["/api/v1/suppressions/{id}", "delete", "200"],
  ["/api/v1/suppressions/{id}/release-requests", "post", "202"],
] as const;

describe("suppression governance OpenAPI availability", () => {
  it.each(OPERATIONS)(
    "marks %s %s as authorization-integration pending without deleting its future success schema",
    (path, method, futureSuccessStatus) => {
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
              "x-runtime-availability"?: string;
            }
          >
        >;
      };
      const operation = document.paths[path]?.[method];

      expect(operation).toBeDefined();
      expect(operation?.["x-runtime-availability"]).toBe(PENDING);
      expect(operation?.description).toContain(
        "currently reaches only the fixed 503",
      );
      expect(operation?.description).toContain("remove this pending marker");
      expect(operation?.responses).toHaveProperty("503");
      expect(operation?.responses).toHaveProperty(futureSuccessStatus);
    },
  );
});
