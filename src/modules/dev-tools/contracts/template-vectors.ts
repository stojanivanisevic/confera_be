import type { DocumentErrorCode } from '../../templates/document';

/**
 * The shared vectors of the template document format (ADR-12, ST-58, ST-59): what the
 * server's checker refuses, and what its serialiser makes of a document. The web
 * application's editor must refuse the same documents and, where it renders a preview of
 * its own, give the same HTML and text. Exported with the schema as
 * contracts/template-vectors.json.
 */
export interface RefusedVector {
  readonly name: string;
  readonly kind: 'body' | 'subject';
  readonly type: 'invitation' | 'security_notice';
  readonly document: unknown;
  readonly code: DocumentErrorCode;
}

export interface RenderedVector {
  readonly name: string;
  readonly type: 'invitation' | 'security_notice';
  readonly subject: unknown;
  readonly body: unknown;
  readonly input: { values: Record<string, string>; conditions: string[]; link?: string };
  readonly expected: { subject: string; html: string; text: string };
}

const text = (value: string, marks?: readonly string[]) =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const placeholder = (key: string) => ({ type: 'placeholder', key });
const paragraph = (...children: unknown[]) => ({ type: 'paragraph', children });
const doc = (...children: unknown[]) => ({ type: 'doc', children });
const subject = (...children: unknown[]) => ({ type: 'subject', children });

/** A paragraph nested nine levels deep through conditionals: one more than the limit. */
function tooDeep(): unknown {
  let node: unknown = paragraph(text('deep'));
  for (let level = 0; level < 9; level += 1) {
    node = { type: 'conditional', key: 'hasActor', children: [node] };
  }
  return doc(node);
}

export const REFUSED_VECTORS: readonly RefusedVector[] = [
  {
    name: 'markup posted in place of the document',
    kind: 'body',
    type: 'invitation',
    document: '<p>Hello</p>',
    code: 'not_a_document',
  },
  {
    name: 'a body that is no document',
    kind: 'body',
    type: 'invitation',
    document: { type: 'paragraph', children: [] },
    code: 'not_a_document',
  },
  {
    name: 'an unknown node',
    kind: 'body',
    type: 'invitation',
    document: doc({ type: 'script', children: [] }),
    code: 'unknown_node',
  },
  {
    name: 'an image, until 0.4.0',
    kind: 'body',
    type: 'invitation',
    document: doc({ type: 'image', fileId: 'x' }),
    code: 'unknown_node',
  },
  {
    name: 'an unknown attribute',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph({ type: 'text', text: 'x', onclick: 'y' })),
    code: 'unknown_attribute',
  },
  {
    name: 'a link with a script scheme',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph({ type: 'link', href: 'javascript:alert(1)', children: [text('x')] })),
    code: 'link_scheme',
  },
  {
    name: 'a link with an http scheme',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph({ type: 'link', href: 'http://example.test/', children: [text('x')] })),
    code: 'link_scheme',
  },
  {
    name: 'a link whose address is a placeholder other than the link',
    kind: 'body',
    type: 'invitation',
    document: doc(
      paragraph({ type: 'link', href: { placeholder: 'recipientName' }, children: [text('x')] }),
    ),
    code: 'link_placeholder',
  },
  {
    name: 'the link placeholder in a type that carries no link',
    kind: 'body',
    type: 'security_notice',
    document: doc(
      paragraph({ type: 'link', href: { placeholder: 'link' }, children: [text('x')] }),
    ),
    code: 'link_placeholder',
  },
  {
    name: 'a placeholder key outside the catalogue of the type',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(placeholder('paymentLink'))),
    code: 'unknown_placeholder',
  },
  {
    name: 'the link as a text placeholder',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(placeholder('link'))),
    code: 'unknown_placeholder',
  },
  {
    name: 'a placeholder key named like a prototype member',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(placeholder('__proto__'))),
    code: 'unknown_placeholder',
  },
  {
    name: 'a placeholder key named constructor',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(placeholder('constructor'))),
    code: 'unknown_placeholder',
  },
  {
    name: 'a condition outside the catalogue',
    kind: 'body',
    type: 'invitation',
    document: doc({ type: 'conditional', key: 'hasActor', children: [] }),
    code: 'unknown_condition',
  },
  {
    name: 'a nesting deeper than the limit',
    kind: 'body',
    type: 'security_notice',
    document: tooDeep(),
    code: 'too_deep',
  },
  {
    name: 'a mark that does not exist',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(text('x', ['blink']))),
    code: 'wrong_attribute',
  },
  {
    name: 'a heading of level 4',
    kind: 'body',
    type: 'invitation',
    document: doc({ type: 'heading', level: 4, children: [text('x')] }),
    code: 'wrong_attribute',
  },
  {
    name: 'a control character in a text',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(text('a\u0007b'))),
    code: 'text_control_character',
  },
  {
    name: 'a document above 200 KB',
    kind: 'body',
    type: 'invitation',
    document: doc(paragraph(text('x'.repeat(200 * 1024)))),
    code: 'too_large',
  },
  {
    name: 'a subject that is no subject',
    kind: 'subject',
    type: 'invitation',
    document: 'Hello',
    code: 'not_a_document',
  },
  {
    name: 'a subject with a line break',
    kind: 'subject',
    type: 'invitation',
    document: subject(text('Hello\nBcc: x')),
    code: 'text_control_character',
  },
  {
    name: 'a subject with a Unicode line separator',
    kind: 'subject',
    type: 'invitation',
    document: subject(text('Hello\u2028x')),
    code: 'text_control_character',
  },
  {
    name: 'a subject with a link',
    kind: 'subject',
    type: 'invitation',
    document: subject({ type: 'link', href: 'https://x.test/', children: [text('x')] }),
    code: 'unknown_node',
  },
  {
    name: 'a subject above 300 characters',
    kind: 'subject',
    type: 'invitation',
    document: subject(text('x'.repeat(301))),
    code: 'subject_too_long',
  },
];

export const RENDERED_VECTORS: readonly RenderedVector[] = [
  {
    name: 'a hostile user name arrives as text; a typed brace is text; the link is the address of the link node (ST-22)',
    type: 'invitation',
    subject: subject(text('Welcome, '), placeholder('recipientName')),
    body: doc(
      paragraph(
        text('Dear '),
        placeholder('recipientName'),
        text(', {{ this is text }} & <b>so is this</b>'),
      ),
      paragraph({
        type: 'link',
        href: { placeholder: 'link' },
        children: [text('Set your password')],
      }),
    ),
    input: {
      values: {
        recipientName: '<img src=x onerror=alert(1)> "Mila" </a><a href="https://evil.test">',
      },
      conditions: [],
      link: 'https://admin.confera.test/invitations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    expected: {
      subject: 'Welcome, <img src=x onerror=alert(1)> "Mila" </a><a href="https://evil.test">',
      html: '<p>Dear &lt;img src=x onerror=alert(1)&gt; &quot;Mila&quot; &lt;/a&gt;&lt;a href=&quot;https://evil.test&quot;&gt;, {{ this is text }} &amp; &lt;b&gt;so is this&lt;/b&gt;</p>\n<p><a href="https://admin.confera.test/invitations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">Set your password</a></p>',
      text: 'Dear <img src=x onerror=alert(1)> "Mila" </a><a href="https://evil.test">, {{ this is text }} & <b>so is this</b>\n\nSet your password <https://admin.confera.test/invitations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA>\n',
    },
  },
  {
    name: 'a subject with line breaks and Unicode line separators in a value arrives as one line (ST-22)',
    type: 'invitation',
    subject: subject(
      text('Welcome, '),
      placeholder('recipientName'),
      text(' to '),
      placeholder('organisationName'),
    ),
    body: doc(paragraph(text('x'))),
    input: {
      values: {
        recipientName: 'Mila\r\nBcc: x@evil.test\u2028Subject: y',
        organisationName: 'Udruženje\u2029z',
      },
      conditions: [],
    },
    expected: {
      subject: 'Welcome, Mila Bcc: x@evil.test Subject: y to Udruženje z',
      html: '<p>x</p>',
      text: 'x\n',
    },
  },
  {
    name: 'headings, marks, lists, a hard break, a typed link and a condition that holds',
    type: 'security_notice',
    subject: subject(text('Notice: '), placeholder('change')),
    body: doc(
      {
        type: 'heading',
        level: 2,
        children: [text('Change at '), placeholder('organisationName')],
      },
      paragraph(
        text('Bold', ['bold']),
        text(' and '),
        text('italic', ['italic', 'underline']),
        { type: 'hardBreak' },
        text('next line'),
      ),
      {
        type: 'bulletList',
        items: [
          { type: 'listItem', children: [text('one')] },
          { type: 'listItem', children: [text('two: '), placeholder('change')] },
        ],
      },
      {
        type: 'numberedList',
        items: [
          { type: 'listItem', children: [text('first')] },
          { type: 'listItem', children: [text('second')] },
        ],
      },
      {
        type: 'conditional',
        key: 'hasActor',
        children: [paragraph(text('By '), placeholder('actorName'))],
      },
      {
        type: 'conditional',
        key: 'hasSubject',
        children: [paragraph(text('Concerning '), placeholder('subjectName'))],
      },
      paragraph({
        type: 'link',
        href: 'https://admin.confera.test/audit',
        children: [text('the audit log')],
      }),
      paragraph({
        type: 'link',
        href: 'mailto:office@example.test',
        children: [text('office@example.test')],
      }),
    ),
    input: {
      values: {
        organisationName: 'Društvo & Co',
        change: 'user_role_changed',
        actorName: 'Đorđe Žikić',
        subjectName: 'Ana Čolić',
      },
      conditions: ['hasActor'],
    },
    expected: {
      subject: 'Notice: user_role_changed',
      html: '<h2>Change at Društvo &amp; Co</h2>\n<p><strong>Bold</strong> and <u><em>italic</em></u><br>next line</p>\n<ul><li>one</li><li>two: user_role_changed</li></ul>\n<ol><li>first</li><li>second</li></ol>\n<p>By Đorđe Žikić</p>\n\n<p><a href="https://admin.confera.test/audit">the audit log</a></p>\n<p><a href="mailto:office@example.test">office@example.test</a></p>',
      text: 'Change at Društvo & Co\n\nBold and italic\nnext line\n\n- one\n- two: user_role_changed\n\n1. first\n2. second\n\nBy Đorđe Žikić\n\nthe audit log <https://admin.confera.test/audit>\n\noffice@example.test <mailto:office@example.test>\n',
    },
  },
];
