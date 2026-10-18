/**
 * Whether a stored file may be served (ADR-10, FR-FILE-02, ST-38): decided by its kind and
 * its scan, never by its id alone; who asks is decided by the route (an admin of the owning
 * organisation for a submission file; a reviewer and a link holder in later milestones).
 *
 * - An uploaded file only when its scan is clean. Pending, also while ClamAV is down: no
 *   "download anyway". Infected or beyond the scanner's limits: never.
 * - A PDF that Confera generated (0.6.0) is not scanned and is served while ClamAV is down.
 */
export type ServeDecision = 'serve' | 'scan_pending' | 'file_not_clean';

export const GENERATED_KINDS: readonly string[] = ['generated_document'];

export function mayServe(file: { kind: string; scanState: string }): ServeDecision {
  if (GENERATED_KINDS.includes(file.kind)) {
    return 'serve';
  }
  if (file.scanState === 'clean') {
    return 'serve';
  }
  return file.scanState === 'pending' ? 'scan_pending' : 'file_not_clean';
}

/**
 * Why a file cannot be downloaded, or null (UX3-07), from the same decision as the download:
 * `scan_retrying` is a pending file whose scan was tried and found the scanner not answering.
 */
export function downloadBlocked(file: {
  kind: string;
  scanState: string;
  scanAttempts: number;
}): 'scan_pending' | 'scan_retrying' | 'file_not_clean' | null {
  const decision = mayServe(file);
  if (decision === 'serve') {
    return null;
  }
  return decision === 'scan_pending' && file.scanAttempts > 0 ? 'scan_retrying' : decision;
}
