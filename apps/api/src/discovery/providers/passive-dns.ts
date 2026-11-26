import { resolveMx, resolveTxt } from 'node:dns/promises';
import { externalActionAuthorized, type ExecutionContext } from '../provider-contract';

/** Observations from DNS configuration. They do not attest ownership, use, or deliverability. */
export interface PassiveDnsSummary {
  readonly mxProvider?: string;
  readonly mxHosts: readonly string[];
  readonly segVendors: readonly string[];
  readonly spfIncludes: readonly string[];
  readonly dmarcPolicy: 'none' | 'quarantine' | 'reject' | null;
  readonly verificationTokens: readonly string[];
  readonly techSignals: readonly string[];
}

export interface InspectPassiveDnsInput {
  readonly domain: string;
  readonly authorizeExternalAction?: ExecutionContext['authorizeExternalAction'];
  readonly resolveMxImpl?: (domain: string) => Promise<Array<{ exchange: string; priority?: number }>>;
  readonly resolveTxtImpl?: (domain: string) => Promise<string[][]>;
  readonly timeoutMs?: number;
}

const DEFAULT_DNS_TIMEOUT_MS = 2_500;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SPF_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;

function normalizeDnsName(raw: string, labelPattern = HOST_LABEL): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/u, '');
  if (value.length > 253) return null;
  const labels = value.split('.');
  if (labels.length < 2 || !/^[a-z]/u.test(labels.at(-1)!) ||
    !labels.every((label) => labelPattern.test(label))) return null;
  return value;
}

function normalizeDnsDomain(raw: string): string | null {
  return normalizeDnsName(raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/\/.*$/u, '')
    .replace(/^www\./u, ''));
}

function withBoundedTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('PASSIVE_DNS_TIMEOUT'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const SEG_DOMAINS = {
  proofpoint: ['pphosted.com', 'ppe-hosted.com'],
  mimecast: ['mimecast.com', 'mimecast.co.za', 'mimecast.co.uk'],
  barracuda: ['barracudanetworks.com', 'barracuda.com'],
  cisco_ironport: ['iphmx.com', 'ironport.com'],
  sophos: ['sophos.com', 'sophosxl.net'],
  fortimail: ['fortimail.com', 'fortimailcloud.com'],
  hornetsecurity: ['hornetsecurity.com', 'antispameurope.com'],
  retarus: ['retarus.com', 'retarus.net'],
  cloudflare_area1: ['area1security.com', 'area1.cloudflare.net'],
} as const;

const MX_PROVIDER_DOMAINS = {
  google_workspace: ['l.google.com', 'googlemail.com', 'smtp.google.com'],
  microsoft_365: ['mail.protection.outlook.com', 'mail.outlook.com', 'mail.protection.office365.us'],
  ...SEG_DOMAINS,
  zoho: ['zoho.com', 'zoho.eu', 'zoho.in', 'zoho.com.au', 'zoho.jp'],
  protonmail: ['protonmail.ch', 'protonmail.com', 'proton.ch'],
  fastmail: ['fastmail.com', 'messagingengine.com'],
  ovh: ['ovh.net', 'ovh.com'],
  ionos: ['ionos.com', 'ionos.de', 'kundenserver.de', 'perfora.net', '1and1.com'],
  hetzner: ['hetzner.com', 'hetzner.de'],
  godaddy: ['secureserver.net'],
} as const;

const SPF_TECH_DOMAINS = {
  hubspot: ['hubspotemail.net'],
  salesforce: ['_spf.salesforce.com'],
  mailchimp: ['mcsv.net', 'mailchimp.com'],
  sendgrid: ['sendgrid.net'],
  klaviyo: ['klaviyo.com'],
  brevo: ['sendinblue.com', 'brevo.com'],
  pardot: ['pardot.com'],
  marketo: ['mktomail.com', 'marketo.com'],
  zendesk: ['zendesk.com'],
  freshdesk: ['freshdesk.com'],
  aws_ses: ['amazonses.com'],
  postmark: ['postmarkapp.com'],
  mailgun: ['mailgun.org', 'mailgun.com'],
} as const;

const VERIFICATION_PREFIXES = {
  google: ['google-site-verification='],
  microsoft: ['ms=ms'],
  hubspot: ['hubspot-developer-verification=', 'hs-verification='],
  facebook: ['facebook-domain-verification='],
  apple: ['apple-domain-verification='],
  docusign: ['docusign='],
  atlassian: ['atlassian-domain-verification='],
  zoho: ['zoho-verification='],
  brevo: ['brevo-code:', 'sendinblue-code:'],
  salesforce: ['salesforce-verification='],
} as const;

function vendorsForHosts(hosts: readonly string[], domains: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(domains)
    .filter(([, suffixes]) => hosts.some((host) => suffixes.some((suffix) =>
      host === suffix || host.endsWith('.' + suffix),
    )))
    .map(([vendor]) => vendor);
}

function normalizeMxHosts(hosts: readonly string[]): string[] {
  const valid = hosts.map((name) => normalizeDnsName(name)).filter((name) => name !== null);
  return [...new Set(valid)].slice(0, 15);
}

function mxProviderForHosts(hosts: readonly string[]): string | undefined {
  return hosts.length ? (vendorsForHosts(hosts, MX_PROVIDER_DOMAINS)[0] ?? 'other_or_self_hosted') : undefined;
}

export function classifyMxExchangeHosts(hosts: readonly string[]): string | undefined {
  return mxProviderForHosts(normalizeMxHosts(hosts));
}

function parseSpfIncludes(txtStrings: readonly string[]): string[] {
  const records = txtStrings.filter((record) => /^v=spf1(?: |$)/iu.test(record));
  if (records.length !== 1) return [];
  const includes = new Set<string>();
  for (const term of records[0]!.split(/ +/u).slice(1)) {
    const rawHost = /^[+?~-]?include:(.+)$/iu.exec(term)?.[1];
    const host = rawHost && normalizeDnsName(rawHost, SPF_LABEL);
    if (host) includes.add(host);
    if (includes.size >= 20) break;
  }
  return [...includes];
}

function parseDmarcPolicy(dmarcStrings: readonly string[]): PassiveDnsSummary['dmarcPolicy'] {
  const records = dmarcStrings.filter((record) => /^v[ \t]*=[ \t]*DMARC1[ \t]*(?:;|$)/u.test(record));
  if (records.length !== 1) return null;
  const tags = records[0]!.split(';').map((tag) => tag.trim());
  const policyTags = tags.filter((tag) => /^p[ \t]*=/u.test(tag));
  if (policyTags.length !== 1) return null;
  const policy = policyTags[0]!.replace(/^p[ \t]*=/u, '').trim();
  return policy === 'none' || policy === 'quarantine' || policy === 'reject' ? policy : null;
}

/**
 * `$0` Passive DNS inspector (MX + TXT SPF/DMARC/verification tokens + SEG/CRM/ESP tech stack).
 * Runs MX, root TXT, and `_dmarc` TXT in parallel under a bounded timeout; never throws on DNS errors.
 */
export async function inspectPassiveDns(
  input: InspectPassiveDnsInput,
): Promise<PassiveDnsSummary | null> {
  const domain = normalizeDnsDomain(input.domain);
  if (!domain) return null;
  if (!(await externalActionAuthorized({ authorizeExternalAction: input.authorizeExternalAction }))) {
    return null;
  }

  const mxFn = input.resolveMxImpl ?? resolveMx;
  const txtFn = input.resolveTxtImpl ?? resolveTxt;
  const timeoutMs = Math.max(100, input.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);

  const [mxRes, txtRes, dmarcRes] = await Promise.allSettled([
    withBoundedTimeout(Promise.resolve().then(() => mxFn(domain)), timeoutMs),
    withBoundedTimeout(Promise.resolve().then(() => txtFn(domain)), timeoutMs),
    withBoundedTimeout(Promise.resolve().then(() => txtFn(`_dmarc.${domain}`)), timeoutMs),
  ]);

  const mxHosts =
    mxRes.status === 'fulfilled'
      ? normalizeMxHosts(mxRes.value.map((record) => record.exchange))
      : [];
  const txtStrings =
    txtRes.status === 'fulfilled'
      ? txtRes.value.map((chunks) => chunks.join('')).filter(Boolean)
      : [];
  const dmarcStrings =
    dmarcRes.status === 'fulfilled'
      ? dmarcRes.value.map((chunks) => chunks.join('')).filter(Boolean)
      : [];

  const mxProvider = mxProviderForHosts(mxHosts);
  const spfIncludes = parseSpfIncludes(txtStrings);
  const dmarcPolicy = parseDmarcPolicy(dmarcStrings);
  const segVendors = vendorsForHosts([...mxHosts, ...spfIncludes], SEG_DOMAINS);
  const techSignals = vendorsForHosts(spfIncludes, SPF_TECH_DOMAINS);
  // Persist the service label only. A TXT challenge cannot prove the service was activated.
  const verificationTokens = Object.entries(VERIFICATION_PREFIXES)
    .filter(([, prefixes]) => txtStrings.some((txt) => prefixes.some((prefix) =>
      txt.toLowerCase().startsWith(prefix) && /^[A-Za-z0-9+/_=.-]+$/u.test(txt.slice(prefix.length)),
    )))
    .map(([vendor]) => vendor);
  if (!mxHosts.length && !spfIncludes.length && !dmarcPolicy && !verificationTokens.length) return null;

  return {
    ...(mxProvider ? { mxProvider } : {}),
    mxHosts,
    segVendors,
    spfIncludes,
    dmarcPolicy,
    verificationTokens,
    techSignals,
  };
}
