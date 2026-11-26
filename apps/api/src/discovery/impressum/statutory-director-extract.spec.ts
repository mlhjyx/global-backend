import { describe, expect, it } from 'vitest';
import { extractStatutoryDirectorsFromHtml } from './statutory-director-extract';

describe('statutory-director-extract ($0 DE/IT/FR/JP/KR Impressum & Privacy extraction)', () => {
  it('extracts DE Geschäftsführer from <footer> even before body footer stripping', () => {
    const html = `<!doctype html><html><body>
      <main><p>Solar GmbH</p></main>
      <footer>
        <p>Impressum</p>
        <p>Geschäftsführer: Dr. Max Mustermann, Erika Musterfrau</p>
        <p>Verantwortlich i.S.d. § 55 RStV: Hans Schmidt</p>
      </footer>
    </body></html>`;
    const directors = extractStatutoryDirectorsFromHtml(html, 'https://solar.de/impressum');
    expect(directors).toEqual([
      {
        name: 'Max Mustermann',
        role: 'Geschäftsführer',
        sourceUrl: 'https://solar.de/impressum',
        jurisdictionHint: 'DE',
      },
      {
        name: 'Erika Musterfrau',
        role: 'Geschäftsführer',
        sourceUrl: 'https://solar.de/impressum',
        jurisdictionHint: 'DE',
      },
    ]);
  });

  it('extracts IT Amministratore Delegato / Legale rappresentante from Informativa Privacy & Note Legali', () => {
    const html = `<html><body>
      <h2>Informativa Privacy</h2>
      <p>Titolare del trattamento:<br>Dott. Mario Rossi</p>
      <p>Amministratore Delegato: Ing. Giulia Bianchi</p>
    </body></html>`;
    const directors = extractStatutoryDirectorsFromHtml(html, 'https://solar.it/informativa-privacy');
    expect(directors.map((d) => [d.name, d.role, d.jurisdictionHint])).toEqual([
      ['Giulia Bianchi', 'Amministratore Delegato', 'IT'],
    ]);
  });

  it('extracts a FR Gérant and ignores the editorial contact in Mentions Légales', () => {
    const html = `<html><body>
      <p>Directeur de la publication : M. Jean-Luc Picard</p>
      <p>Gérant : Mme Claire Moreau</p>
    </body></html>`;
    const directors = extractStatutoryDirectorsFromHtml(html, 'https://solar.fr/mentions-legales');
    expect(directors.map((d) => [d.name, d.role, d.jurisdictionHint])).toEqual([
      ['Claire Moreau', 'Gérant', 'FR'],
    ]);
  });

  it('retains a representative label without upgrading it to managing director', () => {
    const html = '<p>Vertreten durch: Anja Musterfrau</p><p>Vorstand: Max Mustermann</p>';
    const directors = extractStatutoryDirectorsFromHtml(html, 'https://solar.de/impressum');
    expect(directors.map((d) => d.role)).toEqual(['Vertretungsberechtigte Person', 'Vorstand']);
  });

  it('recognizes an explicit inline role label without punctuation', () => {
    const html = '<p><strong>Geschäftsführer</strong> Mira Beispiel</p>';
    const directors = extractStatutoryDirectorsFromHtml(html, 'https://solar.de/impressum');
    expect(directors.map((d) => [d.name, d.role])).toEqual([['Mira Beispiel', 'Geschäftsführer']]);
  });

  it('does not use an adjacent privacy or editorial label as a name for an empty role', () => {
    const html = `<footer>
      <p>Geschäftsführer:</p><p>Verantwortlich für redaktionelle Inhalte</p>
      <p>Legale rappresentante:</p><p>Responsabile del trattamento</p>
    </footer>`;
    expect(extractStatutoryDirectorsFromHtml(html, 'https://sunforge.example/impressum')).toEqual([]);
  });

  it('extracts unspaced JP 代表取締役 and KR 대표자 names while rejecting org names', () => {
    const jpHtml = `<html><body>
      <tr><th>代表取締役</th><td>山田太郎</td></tr>
      <tr><th>代表者</th><td>株式会社ソーラー</td></tr>
    </body></html>`;
    expect(extractStatutoryDirectorsFromHtml(jpHtml, 'https://solar.jp/company-profile')).toEqual([
      {
        name: '山田太郎',
        role: '代表取締役',
        sourceUrl: 'https://solar.jp/company-profile',
        jurisdictionHint: 'JP',
      },
    ]);

    const krHtml = `<html><body>
      <p>대표이사: 김철수</p>
      <p>대표자: 주식회사솔라</p>
    </body></html>`;
    expect(extractStatutoryDirectorsFromHtml(krHtml, 'https://solar.kr/about')).toEqual([
      {
        name: '김철수',
        role: '대표이사',
        sourceUrl: 'https://solar.kr/about',
        jurisdictionHint: 'KR',
      },
    ]);
  });

  it('rejects legal disclaimers, VAT numbers, and organization names masquerading as directors', () => {
    const html = `<html><body>
      <p>Geschäftsführer: Pumpen Schmid GmbH</p>
      <p>Titolare del trattamento: P.IVA 04553650989</p>
      <p>Verantwortlich: info@solar.de</p>
    </body></html>`;
    expect(extractStatutoryDirectorsFromHtml(html, 'https://solar.de/impressum')).toEqual([]);
  });

  it('decodes decimal and hex HTML entities in director names', () => {
    const html = `<footer><p>Gesch&auml;ftsf&#252;hrer: J&#252;rgen Wei&#xdf;</p></footer>`;
    expect(extractStatutoryDirectorsFromHtml(html, 'https://solar.de/impressum')).toEqual([
      {
        name: 'Jürgen Weiß',
        role: 'Geschäftsführer',
        sourceUrl: 'https://solar.de/impressum',
        jurisdictionHint: 'DE',
      },
    ]);
  });
});
