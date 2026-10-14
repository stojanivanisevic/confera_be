import type { Request } from 'express';

/**
 * The address of the client (ADR-03, SEC-A-26, ST-25): the proxy in front of the API
 * overwrites X-Forwarded-For with the address it sees, and the API trusts exactly that
 * one hop (`trust proxy` = 1, set in bootstrap.ts). Express then takes the last address of
 * the header, the one the proxy wrote, and ignores whatever a client wrote before it. The
 * same value feeds the limits, the brake and the security events.
 *
 * Without a proxy (a developer machine, where the web application drops the header) it is
 * the address of the socket.
 */
export const TRUSTED_PROXY_HOPS = 1;

export function clientAddress(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
