import type { PdfDocument } from '../pdf-renderer';

/**
 * The bilingual sample of the PDF spike (M1-BE-05): the shape of a proforma, in Serbian
 * and English, with š č ć ž đ in both cases, a payer in Cyrillic and names that need the
 * fallback font. Every person and organisation is invented (NFR-PRIV-05).
 *
 * `BILINGUAL_SAMPLE_LINES` is the text of the document, line by line in reading order
 * (a table row is one line, its cells separated by a space). The golden test extracts
 * the text of the rendered PDF and expects exactly these lines.
 */

const TITLE = 'Predračun br. 2026-000123 / Proforma invoice no. 2026-000123';
const ISSUER = 'Udruženje za ekonomiju (izmišljeno) / Association for Economics (invented)';
const PANGRAM_SR = 'Šđčćž ŠĐČĆŽ: ljubičasta šljiva, žuta dunja, čađavi džak, ćošak, đerdan.';
const PANGRAM_EN = 'The quick brown fox jumps over the lazy dog: 0123456789.';
const PAYER = 'Platilac / Payer: Živana Đorđević, Ćirila i Metodija 12, 21000 Novi Sad';
const PAYER_CYRILLIC = 'Ćirilicom / In Cyrillic: Ђорђе Жикић, Љубичица Њежић, Џемал Ћосић';
const PAYER_DIGRAPHS = 'Sa digrafima / With digraph letters: ǅemal ǈubica ǌegoš';
const PAYER_GREEK = 'Na grčkom / In Greek: Ἀριστοτέλης Παπαδόπουλος';

const HEAD = ['Opis / Description', 'Kol. / Qty', 'Iznos / Amount'] as const;
const ROWS: readonly (readonly [string, string, string])[] = [
  ['Kotizacija za učesnike / Participation fee', '1', '12.000,00 RSD'],
  ['Štampani zbornik radova / Printed proceedings', '2', '3.600,00 RSD'],
  ['Članarina, đački popust / Membership, student discount', '1', '-1.200,00 RSD'],
];

const TOTAL = 'Ukupno / Total: 14.400,00 RSD';
const VAT_NOTE = 'Oslobođeno PDV-a po članu 25. Zakona. / Exempt from VAT under Article 25.';
const PAY_NOTE = 'Platite putem veze u imejlu. / Pay online through the link in the email.';

export const BILINGUAL_SAMPLE_LINES: readonly string[] = [
  TITLE,
  ISSUER,
  PANGRAM_SR,
  PANGRAM_EN,
  PAYER,
  PAYER_CYRILLIC,
  PAYER_DIGRAPHS,
  PAYER_GREEK,
  HEAD.join(' '),
  ...ROWS.map((row) => row.join(' ')),
  TOTAL,
  VAT_NOTE,
  PAY_NOTE,
];

export const BILINGUAL_SAMPLE: PdfDocument = {
  info: { title: 'Confera: bilingual PDF sample', author: 'Confera' },
  pageSize: 'A4',
  pageMargins: [48, 56, 48, 56],
  defaultStyle: { fontSize: 10, lineHeight: 1.25 },
  styles: {
    title: { fontSize: 14, bold: true, margin: [0, 0, 0, 6] },
    head: { bold: true, fillColor: '#f0ebe2' },
    total: { bold: true, alignment: 'right', margin: [0, 8, 0, 8] },
  },
  content: [
    { text: TITLE, style: 'title' },
    ISSUER,
    { text: PANGRAM_SR, margin: [0, 10, 0, 0] },
    PANGRAM_EN,
    { text: PAYER, margin: [0, 10, 0, 0] },
    PAYER_CYRILLIC,
    PAYER_DIGRAPHS,
    PAYER_GREEK,
    {
      margin: [0, 12, 0, 0],
      table: {
        headerRows: 1,
        widths: ['*', 60, 100],
        body: [
          HEAD.map((text) => ({ text, style: 'head' })),
          ...ROWS.map(([description, quantity, amount]) => [description, quantity, amount]),
        ],
      },
    },
    { text: TOTAL, style: 'total' },
    VAT_NOTE,
    PAY_NOTE,
  ],
};
