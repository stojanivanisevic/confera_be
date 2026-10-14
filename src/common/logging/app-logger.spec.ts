import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { Secret } from '../../config/secret';
import { AppLogger, createRootLogger } from './app-logger';

interface Entry {
  level: string;
  msg: string;
  [field: string]: unknown;
}

function capture(level: 'info' | 'debug' | 'trace' = 'trace') {
  let text = '';
  const logger = new AppLogger(
    createRootLogger(level, { write: (chunk: string) => void (text += chunk) }),
  );
  return {
    logger,
    text: () => text,
    entries: () =>
      text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Entry),
  };
}

const CANARY = 'invented-canary-0f3d9a';

describe('AppLogger', () => {
  it('writes one JSON line per entry, with level, time, service and message', () => {
    const { logger, entries } = capture();
    logger.info('mail.sent', { messageId: 'm-1' });
    expect(entries()).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'mail.sent',
        service: 'confera-api',
        messageId: 'm-1',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    ]);
  });

  it('redacts fields by name, at any depth', () => {
    const { logger, text } = capture();
    logger.info('request', {
      headers: { cookie: `s=${CANARY}`, authorization: `Bearer ${CANARY}`, 'x-csrf-token': CANARY },
      body: { password: CANARY, email: 'mila.petrovic@example.test' },
      user: { passwordHash: CANARY, resetToken: CANARY },
    });
    expect(text()).not.toContain(CANARY);
    expect(text()).not.toContain('example.test');
  });

  it('scrubs credentials out of messages and texts', () => {
    const { logger, text } = capture();
    logger.error(`cannot connect to postgresql://confera_app:${CANARY}@db:5432/confera`);
    logger.warn('driver said', { detail: `password=${CANARY}` });
    logger.log(`smtp://office:${CANARY}@mail.example.test`, 'MailService');
    expect(text()).not.toContain(CANARY);
  });

  it('logs an error with its stack, scrubbed, and without its other properties', () => {
    const { logger, entries, text } = capture();
    const error = Object.assign(new Error(`failed for postgres://a:${CANARY}@h/db`), {
      parameters: [CANARY],
    });
    logger.error('job.failed', error);
    expect(text()).not.toContain(CANARY);
    expect(entries()[0]).toEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'job.failed',
        err: expect.objectContaining({ type: 'Error', stack: expect.any(String) }),
      }),
    );
  });

  it('never prints a Secret', () => {
    const { logger, text } = capture();
    logger.info('config', { database: { applicationUrl: new Secret(CANARY) } });
    logger.log({ url: new Secret(CANARY) });
    expect(text()).not.toContain(CANARY);
  });

  it("accepts Nest's own calls: message and context, and error with stack and context", () => {
    const { logger, entries } = capture();
    logger.log('Nest application successfully started', 'NestApplication');
    logger.error('boom', 'Error: boom\n    at somewhere', 'ExceptionsHandler');
    expect(entries()).toEqual([
      expect.objectContaining({ level: 'info', context: 'NestApplication' }),
      expect.objectContaining({
        level: 'error',
        msg: 'boom',
        context: 'ExceptionsHandler',
        detail: expect.stringContaining('at somewhere'),
      }),
    ]);
  });

  it('keeps the start-up chatter of the framework for the debug level', () => {
    const info = capture('info');
    info.logger.log('AppModule dependencies initialized', 'InstanceLoader');
    info.logger.log('Mapped {/health, GET} route', 'RouterExplorer');
    info.logger.log('Nest application successfully started', 'NestApplication');
    expect(info.entries().map((entry) => entry.context)).toEqual(['NestApplication']);

    const debug = capture('debug');
    debug.logger.log('AppModule dependencies initialized', 'InstanceLoader');
    expect(debug.entries()).toEqual([expect.objectContaining({ level: 'debug' })]);
  });

  it('respects the level', () => {
    const { logger, entries } = capture('info');
    logger.debug('quiet');
    logger.verbose('quieter');
    logger.warn('loud');
    expect(entries().map((entry) => entry.msg)).toEqual(['loud']);
  });

  it('adds the trace id of the current request', async () => {
    const { logger, entries } = capture();
    const cls = ClsServiceManager.getClsService();
    await cls.run(async () => {
      cls.set(CLS_ID, 'trace-123');
      await Promise.resolve();
      logger.info('inside');
    });
    logger.info('outside');
    expect(entries()[0]).toEqual(expect.objectContaining({ msg: 'inside', traceId: 'trace-123' }));
    expect(entries()[1]).not.toHaveProperty('traceId');
  });
});
