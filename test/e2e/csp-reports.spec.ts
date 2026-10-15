import {
  CSP_REPORT_BODY_LIMIT,
  REPORTS_PER_ADDRESS,
} from '../../src/modules/csp-reports/csp-reports.controller';
import { ADMIN_HOST, type E2eApp, PUBLIC_HOST, startE2eApp } from './support/e2e-app';

/**
 * The route that receives the reports of the web application's content security policy
 * (M1-ISS-11): bounded in size and rate, keeping no personal data.
 */
describe('CSP reports', () => {
  jest.setTimeout(120_000);

  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await startE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  /** Something shaped like a link token: it must never reach the log. */
  const TOKEN_SHAPE = 'A'.repeat(43);

  const post = (body: unknown, type = 'application/csp-report', from = '203.0.113.1') =>
    e2e
      .http()
      .post('/public/v1/csp-reports')
      .set('Host', PUBLIC_HOST)
      .set('Origin', 'https://some-site.example')
      .set('X-Forwarded-For', from)
      .set('Content-Type', type)
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  const logged = () => e2e.logs().filter((entry) => entry.msg === 'csp.report');

  it('takes a report in the report-uri shape and logs what matters, without the query, the token or the address', async () => {
    const response = await post({
      'csp-report': {
        'document-uri': `https://admin.confera.test/invitations/${TOKEN_SHAPE}?next=/users&token=${TOKEN_SHAPE}`,
        referrer: `https://evil.example/?session=${TOKEN_SHAPE}`,
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': "default-src 'self'",
        disposition: 'report',
        'blocked-uri': `https://cdn.example/x.js?key=${TOKEN_SHAPE}#frag`,
        'status-code': 200,
        'script-sample': 'alert(document.cookie) and much more than forty characters of text',
      },
    });
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    const [entry] = logged().slice(-1);
    expect(entry).toEqual(
      expect.objectContaining({
        directive: 'script-src-elem',
        blocked: 'https://cdn.example/x.js',
        document: 'https://admin.confera.test/invitations/[token]',
        disposition: 'report',
        status: 200,
        sample: 'alert(document.cookie) and much more tha',
      }),
    );
    const text = JSON.stringify(entry);
    expect(text).not.toContain(TOKEN_SHAPE);
    expect(text).not.toContain('203.0.113.1');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('next=');
  });

  it('takes the report-to shape too, several at once, with an unknown Origin', async () => {
    const before = logged().length;
    const response = await post(
      [
        {
          type: 'csp-violation',
          body: {
            effectiveDirective: 'img-src',
            blockedURL: 'https://x.example/a.png',
            documentURL: 'https://forms.confera.test/f/abstract',
          },
        },
        {
          type: 'csp-violation',
          body: {
            effectiveDirective: 'style-src',
            blockedURL: 'inline',
            documentURL: 'https://forms.confera.test/f/abstract',
          },
        },
        { type: 'other', body: {} },
      ],
      'application/reports+json',
      '203.0.113.2',
    );
    expect(response.status).toBe(204);
    expect(logged().length - before).toBe(2);
  });

  it('answers 204 to a body that is not a report, and logs nothing', async () => {
    const before = logged().length;
    expect((await post('not json at all', 'text/plain', '203.0.113.3')).status).toBe(204);
    expect((await post({ hello: 'world' }, 'application/json', '203.0.113.3')).status).toBe(204);
    // A body that is no JSON is refused by the parser, before the route; nothing is echoed.
    const broken = await post('{"broken"', 'application/csp-report', '203.0.113.3');
    expect(broken.status).toBe(400);
    expect(broken.text).not.toContain('broken');
    expect(logged().length - before).toBe(0);
  });

  it('refuses a body above its limit before reading it', async () => {
    const big = {
      'csp-report': {
        'effective-directive': 'script-src',
        'blocked-uri': 'x'.repeat(CSP_REPORT_BODY_LIMIT),
      },
    };
    const response = await post(big, 'application/csp-report', '203.0.113.4');
    expect(response.status).toBe(413);
    expect(response.body).toEqual(expect.objectContaining({ code: 'payload_too_large' }));
  });

  it('keeps at most the limit of reports per address and hour, and answers 204 beyond it', async () => {
    const before = logged().length;
    for (let index = 0; index < REPORTS_PER_ADDRESS + 5; index += 1) {
      const response = await post(
        { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } },
        'application/csp-report',
        '203.0.113.5',
      );
      expect(response.status).toBe(204);
    }
    expect(logged().length - before).toBe(REPORTS_PER_ADDRESS);
  });

  it('is on the public surface only, and takes no cookie into account', async () => {
    const admin = await e2e
      .http()
      .post('/public/v1/csp-reports')
      .set('Host', ADMIN_HOST)
      .set('Content-Type', 'application/csp-report')
      .send('{}');
    expect(admin.status).toBe(404);
    expect(
      (
        await post({}, 'application/csp-report', '203.0.113.6').set(
          'Cookie',
          '__Host-confera_session=x',
        )
      ).status,
    ).toBe(204);
  });
});
