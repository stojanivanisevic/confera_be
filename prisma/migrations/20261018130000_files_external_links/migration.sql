-- Fixes of the 0.3.0 security review (SEC-M3-06): a .docx whose relationships reach outside
-- it (a remote template, frame or object, a UNC or file: target) is kept and flagged for the
-- office, like an old .doc with macros.

ALTER TABLE "files" DROP CONSTRAINT "files_scan_flag_check";
ALTER TABLE "files" ADD CONSTRAINT "files_scan_flag_check"
  CHECK ("scan_flag" IS NULL OR "scan_flag" IN ('macros', 'external_links'));
