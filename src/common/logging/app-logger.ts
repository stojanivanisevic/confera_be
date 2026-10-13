import { type LoggerService } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from '../../config/config.schema';
import { SERVICE_NAME } from '../version';
import { redact, scrubText } from './redact';

type Fields = Record<string, unknown>;
type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Framework chatter at start (one line per module and route) is kept for debugging only. */
const QUIET_CONTEXTS = new Set(['InstanceLoader', 'RoutesResolver', 'RouterExplorer']);

/**
 * Creates the one logger of the process: JSON lines on stdout.
 * Every entry passes through `redact`, whoever writes it and however.
 */
export function createRootLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      // Errors are shaped by redact() below and by nothing else.
      serializers: { err: (value: unknown) => value },
      formatters: {
        level: (label) => ({ level: label }),
        log: (entry) => redact(entry) as Fields,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg: unknown) =>
            typeof arg === 'string' ? scrubText(arg) : arg,
          ) as typeof args;
          method.apply(this, scrubbed);
        },
      },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}

function traceId(): string | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive() ? cls.getId() : undefined;
}

/**
 * The logger of the application and of Nest itself.
 *
 * Application code logs an event name and fields: `logger.info('mail.sent', { messageId })`.
 * The current request's trace id is added by itself. Nest's own calls
 * (`log(message, context)`) are accepted as they are.
 */
export class AppLogger implements LoggerService {
  constructor(private readonly root: Logger) {}

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  info(message: string, fields: Fields = {}): void {
    this.write('info', message, [fields]);
  }

  /** Nest's name for `info`. */
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    const fields: Fields = {};
    const texts: string[] = [];
    for (const item of rest) {
      if (item instanceof Error) {
        fields.err = item;
      } else if (typeof item === 'string') {
        texts.push(item);
      } else if (item !== null && typeof item === 'object') {
        Object.assign(fields, item);
      }
    }
    // Nest passes the context as the last text, and for errors a stack before it.
    const context = texts.pop();
    if (context !== undefined) {
      fields.context = context;
    }
    if (texts.length > 0) {
      fields.detail = texts.join('\n');
    }

    let text: string;
    if (message instanceof Error) {
      fields.err = message;
      text = message.name;
    } else if (typeof message === 'string') {
      text = message;
    } else {
      fields.value = message;
      text = 'value';
    }

    const id = traceId();
    if (id !== undefined) {
      fields.traceId = id;
    }

    const effective = level === 'info' && QUIET_CONTEXTS.has(String(context)) ? 'debug' : level;
    this.root[effective](fields, text);
  }
}
