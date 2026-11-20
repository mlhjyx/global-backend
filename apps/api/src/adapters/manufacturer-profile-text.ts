export const MANUFACTURER_PROFILE_TEXT_REVISION =
  "manufacturer-profile/v1" as const;
const PREFIX = "<!--manufacturer-profile/v1:";
export const MANUFACTURER_PROFILE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u;

/** Only the capture producer writes this outer header. Publisher text is inside
 * markdown, never parsed recursively as metadata. It carries domains, not PII
 * or relationship facts; original body lines remain the only quotable spans. */
export function readManufacturerProfileText(
  text: string,
): { markdown: string; emailDomains: string[] } | undefined {
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0 || lineEnd > 4096) return undefined;
  const header = text.slice(0, lineEnd);
  if (!header.startsWith(PREFIX) || !header.endsWith("-->")) return undefined;
  try {
    const value = JSON.parse(header.slice(PREFIX.length, -3));
    if (
      !value ||
      Object.keys(value).join() !== "emailDomains" ||
      !Array.isArray(value.emailDomains) ||
      value.emailDomains.length > 8 ||
      value.emailDomains.some(
        (d: unknown) =>
          typeof d !== "string" ||
          d.length > 253 ||
          !MANUFACTURER_PROFILE_DOMAIN.test(d),
      ) ||
      new Set(value.emailDomains).size !== value.emailDomains.length ||
      header !== `${PREFIX}${JSON.stringify(value)}-->`
    )
      return undefined;
    return {
      markdown: text.slice(lineEnd + 1),
      emailDomains: value.emailDomains,
    };
  } catch {
    return undefined;
  }
}

/** Validate before key lookup as well as execute, so malformed options cannot
 * alias a replayable legacy key and avoid execute-time validation. */
export function manufacturerProfileCaptureKey(input: {
  exactHtml?: true;
  profileTextRevision?: unknown;
}): string {
  if (input.profileTextRevision === undefined) return "";
  if (
    input.profileTextRevision !== MANUFACTURER_PROFILE_TEXT_REVISION ||
    input.exactHtml !== true
  )
    throw new Error("CRAWL4AI_FETCH_PROFILE_REVISION_INVALID");
  return `:${MANUFACTURER_PROFILE_TEXT_REVISION}`;
}
