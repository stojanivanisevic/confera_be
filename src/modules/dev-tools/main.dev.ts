// Development entry: the application plus the dev-tools module.
// `pnpm start:dev` runs it from the development build (dist-dev/). It refuses to start
// unless STAGE is local or dev, and the production build does not contain this file.
import { configurationOrRefusal } from '../../startup';

const config = configurationOrRefusal({ developmentEntry: true });
if (config !== undefined) {
  // Loaded only for a start that the configuration allows, as in the production entry.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { start } = require('../../bootstrap') as typeof import('../../bootstrap');
  const { DevToolsModule } = require('./dev-tools.module') as typeof import('./dev-tools.module');
  const { setupApiDocs } = require('./openapi/api-docs') as typeof import('./openapi/api-docs');
  /* eslint-enable @typescript-eslint/no-require-imports */

  void start(config, {
    extraImports: [DevToolsModule],
    configure: (app, appConfig) => {
      if (appConfig.devTools.apiDocs) {
        setupApiDocs(app);
      }
    },
  });
}
