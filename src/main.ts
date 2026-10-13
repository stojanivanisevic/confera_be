// Production entry. The development entry is src/modules/dev-tools/main.dev.ts, which is
// left out of the production build together with the rest of the dev-tools module (ADR-24).
import { start } from './bootstrap';

void start();
