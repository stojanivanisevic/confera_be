import { Body, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { clientAddress } from '../../common/http/client-address';
import { RateLimiter } from '../../common/http/rate-limiter';
import { AppLogger } from '../../common/logging/app-logger';
import { PublicController } from '../../common/http/surface';
import { Public } from '../access/access.decorators';

/**
 * The reports of the web application's content security policy (M1-ISS-11, ADR-28):
 * a browser posts here what the report-only policy would have blocked. The web
 * application points its `report-to` / `report-uri` at `/public/v1/csp-reports`.
 *
 * - Any origin: a browser sends a report without the page's Origin, and it changes nothing.
 * - The body is bounded (CSP_REPORT_BODY_LIMIT, set in bootstrap.ts for this path), and
 *   so is the number of reports per client address (REPORTS_PER_ADDRESS an hour): beyond
 *   it, 204 and nothing kept.
 * - What is kept is the log line of one report: the directive, the blocked address with
 *   its query and fragment cut off, the document path without a query, the disposition,
 *   the status, and the sample of the first 40 characters when the browser gives one.
 *   Never the client address, a cookie, a referrer with a query, or a secure-link token
 *   (a path of `/s/` or `/pay/` is cut at the token).
 */
export const CSP_REPORT_PATH = '/public/v1/csp-reports';
export const CSP_REPORT_BODY_LIMIT = 16 * 1024;
export const REPORTS_PER_ADDRESS = 60;
const MAX_REPORTS_PER_REQUEST = 10;
const MAX_TEXT = 200;
const MAX_SAMPLE = 40;

/** The paths of pages opened by a secure link; the token in them is never logged. */
const LINK_PATH = /^(\/(?:s|pay|invitations|password-resets|email-changes)\/)[^/?#]*/;

export interface KeptReport {
  readonly directive: string;
  readonly blocked: string;
  readonly document: string;
  readonly disposition: string;
  readonly status: number | null;
  readonly sample: string;
}

function text(value: unknown, limit = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, limit) : '';
}

/** An address without its query, its fragment and any secure-link token. */
function safeAddress(value: unknown): string {
  const raw = text(value, 2000);
  let address: string;
  try {
    const url = new URL(raw);
    address = `${url.origin}${url.pathname}`;
  } catch {
    address = raw.split(/[?#]/)[0] ?? '';
  }
  return address
    .replace(
      /^(https?:\/\/[^/]+)?(\/[^?#]*)$/,
      (whole, origin = '', path: string) => `${origin}${path.replace(LINK_PATH, '$1[token]')}`,
    )
    .slice(0, MAX_TEXT);
}

/** One report in either of the two shapes a browser sends: `csp-report` (report-uri) or `body` (report-to). */
export function keptReport(raw: unknown): KeptReport | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const body = (record['csp-report'] ?? record.body ?? record) as Record<string, unknown>;
  if (typeof body !== 'object') {
    return null;
  }
  const directive = text(
    body.effectiveDirective ?? body['effective-directive'] ?? body['violated-directive'],
  );
  if (directive === '') {
    return null;
  }
  const status = body.statusCode ?? body['status-code'];
  return {
    directive,
    blocked: safeAddress(body.blockedURL ?? body['blocked-uri']),
    document: safeAddress(body.documentURL ?? body['document-uri']),
    disposition: text(body.disposition, 20) || 'report',
    status: typeof status === 'number' ? status : null,
    sample: text(body.sample ?? body['script-sample'], MAX_SAMPLE),
  };
}

@PublicController('csp-reports')
export class CspReportsController {
  readonly #perAddress = new RateLimiter(REPORTS_PER_ADDRESS, 60 * 60 * 1000);

  constructor(private readonly logger: AppLogger) {}

  /** Receives the reports. Always 204; what the browser sent is never echoed. */
  @Post()
  @Public({ anyOrigin: true })
  @HttpCode(204)
  receive(@Body() body: unknown, @Req() request: Request): void {
    if (!this.#perAddress.take(clientAddress(request))) {
      return;
    }
    const reports = (Array.isArray(body) ? body : [body]).slice(0, MAX_REPORTS_PER_REQUEST);
    for (const raw of reports) {
      const report = keptReport(raw);
      if (report !== null) {
        this.logger.warn('csp.report', { ...report });
      }
    }
  }
}
