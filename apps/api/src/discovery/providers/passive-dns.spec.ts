import { describe, expect, it, vi } from 'vitest';
import { classifyMxExchangeHosts, inspectPassiveDns } from './passive-dns';

describe('passive-dns ($0 MX/SPF/DMARC/SEG/CRM/ESP stack fingerprint)', () => {
  it('retains only valid DNS names from SPF include mechanisms', async () => {
    const summary = await inspectPassiveDns({
      domain: 'seller.example',
      resolveMxImpl: async () => [],
      resolveTxtImpl: async (name) => name.startsWith('_dmarc.') ? [] : [
        ['v=spf1 include:_spf.seller.example. include:unexpected/path include:bad..example ~all'],
      ],
    });
    expect(summary?.spfIncludes).toEqual(['_spf.seller.example']);
  });

  it('classifies MX providers, SEG vendors, SPF CRM/ESP tech signals, DMARC policy, and verification tokens', async () => {
    const summary = await inspectPassiveDns({
      domain: 'https://www.Novacrest.example/about',
      resolveMxImpl: async () => [
        { exchange: 'mxa-001.gslb.pphosted.com', priority: 10 },
        { exchange: 'aspmx.l.google.com', priority: 20 },
      ],
      resolveTxtImpl: async (name) => {
        if (name === '_dmarc.novacrest.example') {
          return [['v=DMARC1; p=reject; rua=mailto:dmarc@novacrest.example']];
        }
        return [
          ['v=spf1 include:_spf.google.com include:spf.hubspotemail.net include:sendgrid.net ~all'],
          ['google-site-verification=abc123'],
          ['MS=ms99887766'],
          ['docusign=xyz-123'],
        ];
      },
    });

    expect(summary).toEqual({
      mxProvider: 'google_workspace',
      mxHosts: ['mxa-001.gslb.pphosted.com', 'aspmx.l.google.com'],
      segVendors: ['proofpoint'],
      spfIncludes: ['_spf.google.com', 'spf.hubspotemail.net', 'sendgrid.net'],
      dmarcPolicy: 'reject',
      verificationTokens: ['google', 'microsoft', 'docusign'],
      techSignals: ['hubspot', 'sendgrid'],
    });
  });

  it('respects externalActionAuthorized=false without touching DNS resolvers', async () => {
    const mxSpy = vi.fn();
    const txtSpy = vi.fn();
    const summary = await inspectPassiveDns({
      domain: 'novacrest.example',
      authorizeExternalAction: async () => false,
      resolveMxImpl: mxSpy,
      resolveTxtImpl: txtSpy,
    });
    expect(summary).toBeNull();
    expect(mxSpy).not.toHaveBeenCalled();
    expect(txtSpy).not.toHaveBeenCalled();
  });

  it('bounds stalled DNS queries with timeoutMs without throwing', async () => {
    const never = () => new Promise<never>(() => undefined);
    const summary = await inspectPassiveDns({
      domain: 'stalled.example',
      resolveMxImpl: never,
      resolveTxtImpl: never,
      timeoutMs: 100,
    });
    expect(summary).toBeNull();
  });

  it('classifies common EU/enterprise MX gateways accurately', () => {
    expect(classifyMxExchangeHosts(['mail.protection.outlook.com'])).toBe('microsoft_365');
    expect(classifyMxExchangeHosts(['eu-smtp-inbound-1.mimecast.com'])).toBe('mimecast');
    expect(classifyMxExchangeHosts(['mx00.ionos.de'])).toBe('ionos');
    expect(classifyMxExchangeHosts(['mail.custom-erp.de'])).toBe('other_or_self_hosted');
  });

  it('checks exact vendor suffixes, SPF version, DMARC tag boundaries and TXT key placement', async () => {
    const summary = await inspectPassiveDns({
      domain: 'sunforge.example',
      resolveMxImpl: async () => [
        { exchange: '.' },
        { exchange: 'bad..example' },
        { exchange: 'aspmx.l.google.com.unrelated.example.' },
        { exchange: 'does-not-use-mimecast.example' },
      ],
      resolveTxtImpl: async (name) => name.startsWith('_dmarc.') ? [
        ['v=DMARC1; p=reject-pretend; sp=quarantine'],
      ] : [
        ['note=v=spf1 include:sendgrid.net ~all'],
        ['v=spf1 include:mailgun.org.unrelated.example include:_spf.salesforce.com ~all'],
        ['note=google-site-verification=fake'],
        ['google-site-verification='],
        ['facebook-domain-verification=opaque-value'],
      ],
    });
    expect(summary).toEqual({
      mxProvider: 'other_or_self_hosted',
      mxHosts: ['aspmx.l.google.com.unrelated.example', 'does-not-use-mimecast.example'],
      segVendors: [],
      spfIncludes: ['mailgun.org.unrelated.example', '_spf.salesforce.com'],
      dmarcPolicy: null,
      verificationTokens: ['facebook'],
      techSignals: ['salesforce'],
    });
  });

  it('never queries malformed host names or numeric addresses', async () => {
    const resolve = vi.fn(async () => []);
    for (const domain of ['127.0.0.1', 'invalid..example', '-edge.example', 'example.test..']) {
      await expect(inspectPassiveDns({ domain, resolveMxImpl: resolve, resolveTxtImpl: resolve }))
        .resolves.toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
