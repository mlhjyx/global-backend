import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import {
  normalizeArtifactPageText,
  MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS,
} from "../durable-results/artifact/artifact-page-text";
import {
  MANUFACTURER_PROFILE_TEXT_REVISION,
  MANUFACTURER_PROFILE_DOMAIN as DOMAIN,
} from "../adapters/manufacturer-profile-text";

const PREFIX = `<!--${MANUFACTURER_PROFILE_TEXT_REVISION}:`;

/** Reviewed AESSEAL locations static layout: its genuine page h1 is outside
 * article. Only these same-canvas nodes are combined; main's related sections
 * and the document title never enter the profile. Partial layouts fail closed. */
function selectedProfile(document: ReturnType<typeof parseHTML>["document"]) {
  const body = document.body;
  if (
    body.classList.contains("path-node") ||
    body.classList.contains("page-node-type-locations")
  ) {
    if (
      !body.classList.contains("path-node") ||
      !body.classList.contains("page-node-type-locations")
    )
      return undefined;
    const canvases = document.querySelectorAll(
      "div.dialog-off-canvas-main-canvas",
    );
    const profiles = document.querySelectorAll(
      "article.locations.full.clearfix",
    );
    if (canvases.length !== 1 || profiles.length !== 1) return undefined;
    const canvas = canvases[0]!;
    const mains = canvas.querySelectorAll("main.container-fluid.g-0");
    const prefaces = canvas.querySelectorAll(".preface");
    const headings = canvas.querySelectorAll(".preface .page-title h1");
    if (
      mains.length !== 1 ||
      prefaces.length !== 1 ||
      headings.length !== 1 ||
      !mains[0]!.contains(profiles[0]!) ||
      canvas.querySelectorAll("h1").length !== 1
    )
      return undefined;
    const combined = document.createElement("section");
    combined.appendChild(headings[0]!.cloneNode(true));
    combined.appendChild(profiles[0]!.cloneNode(true));
    return combined;
  }
  const articles = document.querySelectorAll("article");
  const mains = document.querySelectorAll("main");
  if (articles.length > 1 || mains.length > 1) return undefined;
  return articles[0] ?? mains[0];
}

/** Same-response DOM view, selected before Readability removes duplicate h1s.
 * Semantic containers only: several articles/mains or no genuine h1 fail closed.
 * No title/name injection and no heuristic selectors based on a target company. */
export function captureManufacturerProfileText(
  html: string,
  minChars: number,
): string | undefined {
  const { document } = parseHTML(html);
  const root = selectedProfile(document);
  if (
    !root ||
    root.querySelectorAll("h1").length !== 1 ||
    !root.querySelector("h1")?.textContent?.trim()
  )
    return undefined;
  for (const node of root.querySelectorAll("script,style,noscript,template"))
    node.remove();
  // Reviewed static UI only. Unknown button content (including negation or
  // another company's text) remains in the profile and in conflict checks.
  for (const button of root.querySelectorAll("button.close")) {
    const span = button.firstElementChild;
    if (
      button.childElementCount === 1 &&
      span?.tagName === "SPAN" &&
      span.childElementCount === 0 &&
      button.textContent?.trim() === "×"
    )
      button.remove();
  }
  // Turndown otherwise drops heading structure around nested block nodes.
  // Flatten only genuine heading DOM text; all letters, names and negatives
  // survive, including other-company headings needed by conflict rejection.
  for (const heading of root.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    heading.textContent = (heading.textContent ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const textNodes: string[] = [];
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  while (walker.nextNode())
    textNodes.push(walker.currentNode.textContent ?? "");
  const emails = [
    ...textNodes,
    ...Array.from(root.querySelectorAll('a[href^="mailto:"]')).map(
      (a) => a.getAttribute("href") ?? "",
    ),
  ].join("\n");
  const domains = Array.from(
    new Set(
      Array.from(
        emails.matchAll(
          /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+\.[a-z]{2,63})/giu,
        ),
        (m) => m[1]!.toLowerCase().replace(/^www\./u, ""),
      ),
    ),
  ).sort();
  if (
    domains.length > 8 ||
    domains.some((d) => d.length > 253 || !DOMAIN.test(d))
  )
    return undefined;
  // Remove mailto hrefs before Markdown conversion so neither address nor local
  // part can enter producer metadata or the artifact's retained body.
  for (const a of root.querySelectorAll('a[href^="mailto:"]'))
    a.removeAttribute("href");
  const markdown = normalizeArtifactPageText(
    new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    }).turndown(root.innerHTML),
  );
  // A cap-sized body may already have lost a negative or foreign heading.
  // It is not complete evidence, even if the remaining prefix looks positive.
  if (
    markdown.length < minChars ||
    Array.from(markdown).length >= MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS
  )
    return undefined;
  const profile = `${PREFIX}${JSON.stringify({ emailDomains: domains })}-->\n${markdown}`;
  // Include the producer header in the artifact limit and require the exact
  // full view to survive the same canonicalization used by storage/replay.
  // Any cap or second-pass privacy rewrite is an unusable capture, not a prefix.
  return normalizeArtifactPageText(profile) === profile ? profile : undefined;
}
