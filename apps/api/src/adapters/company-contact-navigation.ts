import type { CompanyNavigationCapture } from './company-navigation';
import { companyNavigationLinks } from '../discovery/website-profile/contact-paths';

/** Fixed Tool composition only. It observes this guarded response; it never fetches a link. */
export const captureCompanyContactNavigation: CompanyNavigationCapture = (document, requestedUrl, responseUrl) => {
  let base: URL, company: URL;
  try {
    company = new URL(requestedUrl);
    base = new URL(responseUrl);
    const bases = Array.from(document.querySelectorAll('base[href]'));
    for (const node of bases) if (node.closest('template,noscript')) node.removeAttribute('href');
    const declared = bases.find(node => node.hasAttribute('href'));
    const href = declared?.getAttribute('href');
    if (href) {
      try { base = new URL(href, base); } catch { /* Invalid HTML base falls back to the actual response URI. */ }
    }
    // Readability must see the same response/base context as the projection. This
    // only supplies browser-implicit URI metadata, never invented navigation.
    if (declared) declared.setAttribute('href', base.href);
    else if (responseUrl !== requestedUrl && document.head) {
      const context = document.createElement('base'); context.setAttribute('href', base.href); document.head.prepend(context);
    }
  } catch { throw new Error('COMPANY_NAVIGATION_RESPONSE_URI_INVALID'); }
  function* links() {
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      if (anchor.closest('script,style,template,noscript')) continue;
      const href = anchor.getAttribute('href') ?? '';
      if (!href || href.length > 2048) continue;
      let target: URL;
      try { target = new URL(href, base); } catch { continue; }
      const labelNode = anchor.cloneNode(true) as Element;
      for (const hidden of Array.from(labelNode.querySelectorAll('script,style,template,noscript'))) hidden.remove();
      const rawLabel = labelNode.textContent ?? '';
      yield { target: target.toString(), label: rawLabel.length <= 120 ? rawLabel : '' };
    }
  }
  // All URLs come from real anchors and the unchanged strict finder. Labels here
  // are fixed vocabulary, not page text/names; at most six canonical links.
  return companyNavigationLinks(links(), company.hostname).map(link => `[${link.label}](${link.target})`).join('\n');
};
