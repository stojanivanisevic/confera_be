import { type ConfigResult, parseEnvironment } from './config';

/**
 * The one place in the application that reads the process environment (ADR-01).
 * Everything else receives the validated `AppConfig`.
 */
export function loadConfig(): ConfigResult {
  return parseEnvironment(process.env);
}
