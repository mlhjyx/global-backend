import { describe, expect, it } from "vitest";
import { createRedactedModelResponseShape } from "./types";

describe("createRedactedModelResponseShape", () => {
  it("extracts allowlisted validation paths from a direct issue-array cause without retaining values", () => {
    const sensitiveValue = "sensitive-value-must-not-enter-diagnostics";

    const shape = createRedactedModelResponseShape(
      {
        content: [{ type: "thinking", thinking: sensitiveValue }],
        usage: { output_tokens_details: { thinking_tokens: sensitiveValue } },
      },
      {
        cause: [
          { path: ["content", 0, "signature"], message: sensitiveValue },
          {
            path: ["private_payload", "secret"],
            message: sensitiveValue,
          },
        ],
      },
    );

    expect(shape).toEqual({
      schemaVersion: "native-model-response-shape/2026-08-09-v1",
      topLevelKeys: ["content", "usage"],
      contentBlockTypes: ["thinking"],
      usageKeys: ["output_tokens_details"],
      validationPaths: ["content[0].signature"],
    });
    expect(JSON.stringify(shape)).not.toContain(sensitiveValue);
    expect(JSON.stringify(shape)).not.toContain("private_payload");
  });
});
