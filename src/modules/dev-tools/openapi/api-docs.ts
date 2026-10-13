import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { DEV_TOOLS_ROUTES } from '../dev-tools.routes';
import { buildDocuments } from './document';

/**
 * The interactive API documentation, for STAGE=local and dev with DEV_API_DOCS=true:
 *
 *   /dev/docs          admin API
 *   /dev/docs/public   public API
 *
 * The API's own content security policy allows nothing; the documentation is a page with
 * scripts and styles, so these two addresses get a policy that allows its own files.
 */
const DOCS_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

function docsPolicy(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', DOCS_POLICY);
  next();
}

export function setupApiDocs(app: NestExpressApplication): void {
  const documents = buildDocuments(app);
  app.use(`/${DEV_TOOLS_ROUTES.apiDocs}`, docsPolicy);
  SwaggerModule.setup(`${DEV_TOOLS_ROUTES.apiDocs}/public`, app, documents.public, {
    customSiteTitle: 'Confera public API',
  });
  SwaggerModule.setup(DEV_TOOLS_ROUTES.apiDocs, app, documents.admin, {
    customSiteTitle: 'Confera admin API',
  });
}
