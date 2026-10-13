import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger';

@Global()
@Module({})
export class LoggingModule {
  /** The logger is created before the application, so that the start itself is logged through it. */
  static register(logger: AppLogger): DynamicModule {
    return {
      module: LoggingModule,
      providers: [{ provide: AppLogger, useValue: logger }],
      exports: [AppLogger],
    };
  }
}
