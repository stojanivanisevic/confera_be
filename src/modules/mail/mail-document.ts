import type { Language } from '../templates/placeholders';

/** The language tag of a message: Serbian is written in Latin letters. */
export function languageTag(language: Language): string {
  return language === 'sr' ? 'sr-Latn' : 'en';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The HTML part as it is sent (UX4-03): a whole document around the rendered body, with the
 * language of the message, its subject as the title, and a few inline styles that mail
 * programs keep (one column of at most 600 pixels, a sans-serif face, 16 px text). The body
 * is the checked rendering of the template (render.ts); the mail log and the preview keep
 * the body alone. No class, no style sheet, no remote resource.
 */
export function mailDocument(body: string, subject: string, language: Language): string {
  const tag = languageTag(language);
  return [
    '<!DOCTYPE html>',
    `<html lang="${tag}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background:#ffffff;">',
    `<div lang="${tag}" style="max-width:600px;margin:0 auto;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;">`,
    body,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
