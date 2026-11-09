import { describe, expect, it } from 'vitest';
import { planContactCompletion } from './contact-completion';

const HOME_MD = [
  '# Acme Pumpen GmbH',
  '',
  'Willkommen.',
  '',
  '- [Impressum](https://acme-pumpen.de/impressum)',
  '- [Kontakt](https://acme-pumpen.de/kontakt)',
  '- [LinkedIn](https://www.linkedin.com/company/acme-pumpen/)',
  '- [Karriere](https://www.linkedin.com/in/max-mustermann)',
].join('\n');

describe('planContactCompletion', () => {
  it('plans phones from the Impressum and the company LinkedIn page from the homepage', () => {
    const plan = planContactCompletion({
      domain: 'acme-pumpen.de',
      country: 'DE',
      homeMarkdown: HOME_MD,
      pages: [
        {
          url: 'https://acme-pumpen.de/impressum',
          kind: 'impressum',
          html: '<p>Telefon: <a href="tel:+49 30 1234567">+49 30 1234567</a></p>',
          text: 'Telefon: +49 30 1234567',
        },
      ],
    });
    expect(plan.channels.map((channel) => channel.channel)).toEqual(['phone']);
    expect(plan.channels[0]?.value).toBe('+49301234567');
    expect(plan.channels[0]?.sourceType).toBe('impressum');
    expect(plan.linkedinCompanyPage).toBe('https://www.linkedin.com/company/acme-pumpen');
  });

  it('never plans email channels (emails keep their own pipeline)', () => {
    const plan = planContactCompletion({
      domain: 'acme-pumpen.de',
      country: 'DE',
      homeMarkdown: HOME_MD,
      pages: [
        {
          url: 'https://acme-pumpen.de/impressum',
          kind: 'impressum',
          html: '<a href="mailto:info@acme-pumpen.de">info@acme-pumpen.de</a><a href="tel:+49301234567">x</a>',
          text: 'info@acme-pumpen.de +49 30 1234567',
        },
      ],
    });
    expect(plan.channels.every((channel) => channel.channel !== 'email')).toBe(true);
    expect(plan.channels.some((channel) => channel.channel === 'phone')).toBe(true);
  });

  it('plans the contact form URL from a contact page carrying a form', () => {
    const plan = planContactCompletion({
      domain: 'acme-pumpen.de',
      country: 'DE',
      homeMarkdown: HOME_MD,
      pages: [
        {
          url: 'https://acme-pumpen.de/kontakt',
          kind: 'contact',
          html: '<form><input name="email"></form>',
          text: 'Kontaktformular',
        },
      ],
    });
    expect(plan.channels.find((channel) => channel.channel === 'form_url')?.value).toBe(
      'https://acme-pumpen.de/kontakt',
    );
  });

  it('leaves LinkedIn null when the homepage only links personal profiles', () => {
    const plan = planContactCompletion({
      domain: 'acme-pumpen.de',
      country: 'DE',
      homeMarkdown: '- [Max](https://www.linkedin.com/in/max-mustermann)',
      pages: [],
    });
    expect(plan.linkedinCompanyPage).toBeNull();
    expect(plan.channels).toEqual([]);
  });

  it('returns an empty plan when nothing is extractable', () => {
    const plan = planContactCompletion({
      domain: 'acme-pumpen.de',
      country: 'DE',
      homeMarkdown: '',
      pages: [],
    });
    expect(plan).toMatchObject({ channels: [], linkedinCompanyPage: null });
  });
});
