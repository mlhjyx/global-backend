import { createHash } from "node:crypto";
const invalid = () => {
  throw new Error("TEMPORAL_NATIVE_SBOM_INVALID");
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  [...value].every(
    (character) =>
      character.codePointAt(0) > 0x20 && character.codePointAt(0) !== 0x7f,
  );

/** Inventories the actual compiled Go build-info plus the actual pinned base's
 * APK records. It is not a vulnerability scan or an inventory of unmanaged tools. */
export function nativeSbom(source, binary, buildInfo, apk) {
  try {
    if (
      !/^docker\.io\/temporalio\/server@sha256:[a-f0-9]{64}$/.test(
        source.upstreamImage,
      ) ||
      !/^[a-f0-9]{40}$/.test(source.sourceSha) ||
      !/^sha256:[a-f0-9]{64}$/.test(source.sourceDigest) ||
      !Buffer.isBuffer(binary) ||
      binary.length < 8 ||
      buildInfo?.Path !== "global.local/temporal-platform-server/cmd/server" ||
      !/^go1\.[0-9]+\.[0-9]+$/.test(buildInfo.GoVersion) ||
      !Array.isArray(buildInfo.Deps) ||
      buildInfo.Deps.length < 1 ||
      buildInfo.Deps.length > 5000 ||
      !Buffer.isBuffer(apk) ||
      apk.length < 8 ||
      apk.length > 8 * 1024 * 1024
    )
      invalid();
    const components = [];
    for (const dependency of buildInfo.Deps) {
      const module = dependency.Replace ?? dependency;
      if (
        !text(module.Path) ||
        !text(module.Version) ||
        !text(module.Sum) ||
        !module.Sum.startsWith("h1:")
      )
        invalid();
      const purl =
        "pkg:golang/" +
        module.Path.split("/").map(encodeURIComponent).join("/") +
        "@" +
        encodeURIComponent(module.Version);
      components.push({
        type: "library",
        name: module.Path,
        version: module.Version,
        purl,
        "bom-ref": purl,
        properties: [
          { name: "go:module:h1", value: module.Sum },
          ...(dependency.Replace
            ? [{ name: "go:replaces", value: dependency.Path }]
            : []),
        ],
      });
    }
    let packageCount = 0;
    for (const block of apk
      .toString("utf8")
      .trim()
      .split(/\n\s*\n/)) {
      const fields = {};
      for (const line of block.split("\n")) {
        if (!/^[PVAC]:/.test(line)) continue;
        const key = line[0];
        if (Object.hasOwn(fields, key)) invalid();
        fields[key] = line.slice(2);
      }
      if (!["P", "V", "A", "C"].every((key) => text(fields[key]))) invalid();
      const purl =
        "pkg:apk/alpine/" +
        encodeURIComponent(fields.P) +
        "@" +
        encodeURIComponent(fields.V) +
        "?arch=" +
        encodeURIComponent(fields.A);
      components.push({
        type: "library",
        name: fields.P,
        version: fields.V,
        purl,
        "bom-ref": purl,
        properties: [
          { name: "apk:architecture", value: fields.A },
          { name: "apk:recorded-checksum", value: fields.C },
        ],
      });
      if (++packageCount > 10000) invalid();
    }
    components.push({
      type: "container",
      name: source.upstreamImage,
      version: source.upstreamImage.split("@")[1],
      "bom-ref": source.upstreamImage,
    });
    components.push({
      type: "application",
      name: "Go toolchain",
      version: buildInfo.GoVersion,
      "bom-ref": "go-toolchain:" + buildInfo.GoVersion,
    });
    if (new Set(components.map((c) => c["bom-ref"])).size !== components.length)
      invalid();
    components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
    return {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "application",
          name: "global-temporal-platform",
          version: source.sourceSha,
          hashes: [{ alg: "SHA-256", content: hash(binary) }],
        },
      },
      components,
      properties: [
        { name: "native:source-digest", value: source.sourceDigest },
        { name: "go:inventory", value: "ACTUAL_BINARY_BUILD_INFO" },
        { name: "os:inventory", value: "ACTUAL_PINNED_BASE_APK_DATABASE" },
        { name: "os:apk-database-sha256", value: hash(apk) },
        {
          name: "upstream:unmanaged-tools",
          value: "OPAQUE_PINNED_BASE_COMPONENT",
        },
        { name: "vulnerability_scan", value: "NOT_RUN" },
      ],
    };
  } catch {
    return invalid();
  }
}
