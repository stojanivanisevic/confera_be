import { Module } from '@nestjs/common';
import { FilesWorker } from './files-worker';
import { FileStorage } from './storage';
import { ClamdScanner, VIRUS_SCANNER } from './virus-scanner';

/**
 * Files (ADR-10): the private storage, the antivirus behind its interface, and the
 * background work of scans and purges. No controller: a file is served only by the route of
 * its owner (a submission's files by the submissions module).
 */
@Module({
  providers: [FileStorage, { provide: VIRUS_SCANNER, useClass: ClamdScanner }, FilesWorker],
  exports: [FileStorage, VIRUS_SCANNER, FilesWorker],
})
export class FilesModule {}
