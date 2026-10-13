import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AppLogger } from '../logging/app-logger';
import { sendProblem, toProblem } from './problem';
import { currentTraceId } from './trace';

/**
 * The one exception filter of the API (ADR-19). Everything that is thrown ends here.
 * An unexpected error is logged in full under its trace id; the client gets the code and
 * the trace id only.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const problem = toProblem(exception, currentTraceId());
    if (problem.unexpected) {
      this.logger.error(
        'request.failed',
        exception instanceof Error ? exception : { value: exception },
      );
    }
    sendProblem(response, problem);
  }
}
