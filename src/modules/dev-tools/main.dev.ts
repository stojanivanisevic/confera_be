// Development entry: the application plus the dev-tools module.
// `pnpm start:dev` runs it from the development build (dist-dev/). It refuses to start
// unless STAGE is local or dev, and the production build does not contain this file.
import { start } from '../../bootstrap';
import { DevToolsModule } from './dev-tools.module';
import { setupApiDocs } from './openapi/api-docs';

void start({
  developmentEntry: true,
  extraImports: [DevToolsModule],
  configure: (app, config) => {
    if (config.devTools.apiDocs) {
      setupApiDocs(app);
    }
  },
});
