/**
 * Closed, conservative classifier shared by acquisition cleaning and contact identity.
 * Unknown local parts are treated as personal mailboxes.
 */
const ROLE_MAILBOX_LOCAL_PARTS = new Set([
  'info', 'sales', 'contact', 'kontakt', 'office', 'mail', 'email', 'hello', 'hallo',
  'service', 'support', 'vertrieb', 'verkauf', 'anfrage', 'enquiry', 'enquiries', 'inquiry',
  'marketing', 'admin', 'welcome', 'team', 'press', 'presse', 'export', 'import', 'shop',
  'orders', 'order', 'bestellung', 'purchasing', 'procurement', 'einkauf', 'buy',
  'hr', 'jobs', 'job', 'career', 'careers', 'recruiting', 'recruitment', 'bewerbung',
  'accounts', 'accounting', 'billing', 'invoice', 'invoicing', 'finance', 'buchhaltung',
  'help', 'helpdesk', 'webmaster', 'postmaster', 'abuse', 'privacy', 'legal', 'dpo',
  'compliance', 'quality', 'qa', 'rfq', 'quote', 'quotes', 'reception', 'empfang', 'zentrale',
  'general', 'main', 'company', 'all', 'newsletter', 'noreply', 'mailbox',
]);

export type ContactEmailKind = 'role' | 'personal';

export function contactEmailKind(raw: string): ContactEmailKind {
  const local = raw.trim().toLowerCase().split('@')[0] ?? '';
  const bare = local.replace(/[._-]?\d+$/, '').replace(/[._-](eu|us|de|uk|global|team)$/i, '');
  return ROLE_MAILBOX_LOCAL_PARTS.has(local) ||
    ROLE_MAILBOX_LOCAL_PARTS.has(bare) ||
    /^(no-?reply|do-?not-?reply|newsletter|mailbox|postmaster|webmaster)$/.test(local)
    ? 'role'
    : 'personal';
}
