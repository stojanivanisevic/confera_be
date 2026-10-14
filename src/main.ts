// Production entry. The development entry is src/modules/dev-tools/main.dev.ts, which is
// left out of the production build together with the rest of the dev-tools module (ADR-24).
import { configurationOrRefusal } from './startup';

const config = configurationOrRefusal();
if (config !== undefined) {
  // The framework and the application are loaded only for a start that the configuration
  // allows: a refused start ends before any of it is read from the disk.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { start } = require('./bootstrap') as typeof import('./bootstrap');
  void start(config);
}
