# Changelog

All notable changes to this repository are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/). `confera_be` and `confera_fe` carry the same
version at every milestone (ADR-19).

## [Unreleased]

Statuses, status emails, template management, email images and the mail log (0.4.0, backend).

### Added

- The status model of Spec section 5 (M4-BE-01; FR-SUB-05 to 08; ST-43): `POST /api/v1/submissions/{id}/status` by the state table, transition 2 a POST and never a side effect of a GET, versions against double clicks and two admins, the history with transition, reason, text and email state; notes; corrections on the author's behalf with kept revisions; withdrawal out of the default view.
- Status emails (M4-BE-02; FR-MAIL-03, 05, 07, 08; ST-44): seven template types in English and Serbian, queued and rendered in the transaction of the change, the server's preview with a digest the change must send back, and the switch per conference.
- Template management (M4-BE-03; ST-58, ST-59): create, change and remove overrides, the effective fallback per conference, checks on save, the server's sample render; the image node and the multi-line note in the document format; an allowlist pass over the rendered HTML.
- The table's search without diacritics (đ as dj, Serbian Cyrillic), filters, a fixed sort map and paging (M4-BE-04, NFR-PERF-02 with 20,000 rows).
- Resend from the mail log with fresh links, the retention setting and its job (M4-BE-05); the maintenance worker also runs the security summary (M2-ISS-12).
- Email images (M4-BE-06; ST-60, ST-67): a private file kind, typed by content, size from the header, decoded and re-encoded in a worker thread by pure JavaScript decoders (pngjs 7.0.0, jpeg-js 0.4.4, omggif 1.0.10), scanned, sent as inline parts.
- The staging mail redirect to the catcher (`STAGING_MAIL_CATCHER`, ST-50) and `instance` in `/api/v1/meta`.
- Held mail can be discarded (M3-ISS-14); `sessions:revoke-all` (M2-ISS-12).

### Changed

- The status `received` is `new`; a message is rendered when it is queued (M2-ISS-05); the trap alias `website` is gone (M3-ISS-19); failed test messages name a cause and test messages are capped and rate-limited (M2-ISS-14, M3-ISS-02); `db:provision` sends SCRAM verifiers (M1-ISS-14); documentation, 6to4 and local NAT64 mail targets are refused (M2-ISS-19); a GCM tag must be 16 bytes (M2-ISS-20); the Serbian confirmation no longer declines the conference name (M3-ISS-13); an unterminated comment in a `.docx` part is scanned by the engine's search (M3-ISS-12).

### Security

- Dependencies (Q4-08), so that `pnpm audit` passes again: body-parser 2.3.0 to 2.4.0 (GHSA-27r3-jxmh-p828, high: a denial of service through trailing bytes after a compressed body; through express 5.2.1, whose range takes it), multer 2.4.0 to 2.5.0 (GHSA-q7qp-rjg7-q26m, high: a denial of service through a pending asynchronous `fileFilter`; an override, since @nestjs/platform-express 12.1.2 pins 2.4.0; Confera reads uploads with busboy), zod 4.6.5 to 4.6.7 (GHSA-mrhx-c7xc-m3w5, high: memory exhausted while validating oversized constrained collections). Also, below the gate: nodemailer 10.1.0 to 10.1.7 (GHSA-8c8m-p3m8-cjg8 and two more moderate advisories of its address parser, which could turn display text into a recipient) and fast-uri 3.1.8 to 3.1.9 (two moderate and two low advisories). body-parser 2.4.0 and multer 2.5.0 were two days old: `minimumReleaseAgeExclude` names those two exact versions until they are three days old, and `pnpm supply-chain` refuses an entry that is not one exact version.
- Email images (SEC-M4-01, SEC-M4-04, Q4-02): a GIF frame that does not fit its logical screen, or has more than 16 megapixels, is refused from its image descriptor (422 `image_too_many_pixels`), and the worker checks the first frame again before it allocates; one image is decoded at a time in the process (at most 16 wait, then 429 `image_busy`); an admin uploads at most 30 images in ten minutes (429 `too_many_requests`); the quota of 500 is counted again under a lock in the insert.
- Resend from the mail log (SEC-M4-02): an email change confirmation is never resent; a message with a link is not resent when it failed as stale or the password or the address changed after its first request, and the sender judges a resend by the time of that first request. New column `users.email_changed_at`.
- The first author's name passes the filter of the title in every email (one line, no address, no bare domain, else empty; SEC-M4-03).
- Every status change whose email is on, except `open`, needs the `previewDigest` of its preview (400 at `previewDigest` without it; SEC-M4-05).
- The audit entry of a discard of held mail lists the ids discarded (`detail.ids`, SEC-M4-08).

### Fixed (0.4.0 fix round)

- "dordevic" finds "Đorđević": a text with đ is indexed with đ as dj and as d (Q4-01); migration `20261024090000_search_text_d_form` rewrites the stored rows that hold a đ.
- `MailImageDto` and `MailImageListDto` describe their fields in the OpenAPI document (they moved to `mail-images.dto.ts`; Q4-04).
- The sent HTML is a whole document with `lang`, `<title>` and `Content-Language` in the message's language, and a few inline styles (UX4-03); an image is no wider than the screen, and one not yet clean shows its words (UX4-04).
- The Serbian default templates never decline a name (UX4-05, M3-ISS-13): "organizacija: …", "server: …". The seeded texts already write Vi, Vas and Vaša capitalised throughout.
- A mail to an author has `Reply-To` the organisation's contact address, and the returned-for-revision mail names it, or asks to send the text to the office when there is none (placeholder `contactEmail`, conditions `hasContact` and `noContact`; UX4-06).
- Title, first author and institution sort in the Serbian Latin alphabet (ICU `sr-Latn`; UX4-15; migration `20261024100000_serbian_sort_collation`).
- `GET /api/v1/mail-log` takes `q`, words searched in the recipient and the subject (UX4-13).
- Tests: the resend case of a test message sets up its own message (Q4-07); the ST-44 vectors of the author's name; the resend refusals; the digest of every change.

## 0.3.0 – 2026-10-18

Forms, embed and intake: the public abstract form, its files and its confirmation, and the admin API of forms, deadlines, submissions and held mail.

### Added

- Forms and their immutable versions (M3-BE-01, ADR-09; FR-FORM-01, FR-FORM-02): a field catalogue in code that reproduces the current abstract form field by field, the admin's configuration as the draft (fields on and off, labels, help and options in both languages, required, word and character limits, file types and sizes, the texts, the most authors: 10 by default, D7), publish into a version the application role can only read and add; form texts as plain text with one safe link syntax and the conference's consent links (D6: `publicationTermsUrl`, `privacyNoticeUrl`). `seed:production` gives each conference that has none an unpublished abstract form; `seed:e2e` publishes one under the fixed address `e2eprobnaforma01`.
- The rule interpreter and its shared contracts (M3-BE-02, ST-41): `contracts/form-definition.schema.json`, `contracts/form-configuration.schema.json` and `contracts/form-rule-vectors.json` (codes, order, word count, the URL rule, the address rule, the safe text, the proof-of-work, answers with their errors); key-checked answers, patterns from the catalogue only, stated maxima (a 64 KB body, 20 000 characters a value, 5 000 words a long text, 50 authors); a key named like a prototype member is refused, not dropped.
- The public form API (M3-BE-03, ADR-08; ST-31, ST-34): the published form and its frame sites, a single-use form token (6 hours) fetched by the page and sent in `X-Form-Token`, the Origin, `Sec-Fetch-Site` and content-type checks, no session cookie and no CORS grant, limits per client, a proof-of-work of our own, the trap field and the minimum fill time (3 s), one idempotent submit (`Idempotency-Key`) in one transaction with the submission, its authors, files, first status, consent and confirmation. References like `IT27-0001`, unique in the organisation.
- A refused form token is renewed with `previousFormToken` in the body of `POST /public/v1/forms/{slug}/tokens`: the renewal keeps the files and the start of filling in, and the submit that follows at once is stored, never answered with a fake success (Q3-01).
- Files (M3-BE-04, ADR-10; ST-32, ST-33, ST-39): private storage under keys without client names (`FILE_STORAGE_DIR`), streamed uploads cut off one byte beyond the field's limit (20 MB by default, at most 50 MB), the SHA-256, the type from the content (PDF, `.docx`, `.doc`, JPEG, PNG), the macro policy of G2-22 (a `.docx` with macros refused with 422 `docx_macros`, an old `.doc` with macros kept and flagged), uploads bound to a token and a file field, a quota of 2 GB of unattached bytes per organisation with a notice to the admins, a purge of unattached files, safe file-name headers, downloads only through the submission and only when clean. busboy 1.6.0.
- Deadlines in the conference's time zone (M3-BE-05, FR-DL-01 to 03): a day that ends at the end of that day where the conference is, also when the clocks change; the form closes by itself and opens again on an extension; the history with the old and new day and who changed it.
- The consent record and the confirmation email (M3-BE-06; FR-FORM-11, FR-FORM-15 as amended by SA-13, FR-MAIL-04; ST-35): the consent text as shown, its links, a hash and the time; a confirmation with fixed text, the reference and the title only, cut to 200 characters, in the submission's language (template type `submission_confirmation`, English and Serbian; eight template types in all).
- The submissions read API (M3-BE-07; FR-SUB-02, FR-SUB-04): a paged table (at most 100 a page) and the detail (answers, authors, files with their scan state, consent, status history, emails).
- The antivirus (M3-BE-08, ST-38): ClamAV's daemon over INSTREAM (`CLAMAV_ADDRESS`), in the background once a file is attached; fail closed (pending with retries and a notice to the admins, never "download anyway"); limits exceeded are not clean. The development stack has no ClamAV; the tests use a fake daemon of the same protocol.
- The send breaker (M3-BE-09, ADR-08; ST-34): per form and per organisation (30 an hour, 200 a day by default) and per recipient domain (100 a day); above it the submission is stored, its confirmation held, the admins told once an hour per form; the held emails listed and released by an admin.
- A copy of a conference takes its forms as unpublished drafts with their configuration (FR-CONF-03); a version number beyond any form answers 404.
- The OpenAPI document describes the responses of deadlines, submissions and held mail; `PublicFormDto.contactEmail` (D8) and `FormDto.catalogue` with the mandatory flags (M3-ISS-05).
- From the UX review (UX3-06, UX3-07): `HeldMailDto.heldBy` and `SubmissionEmailDto.heldBy` say by which numbers an email was held (`count`, `limit`, `windowHours`); `SubmissionSummaryDto.fileSigns` gives the flags of a submission's files and whether a scan is pending; `SubmissionFileDto.downloadBlocked` (`scan_pending`, `scan_retrying`, `file_not_clean`) and `nextScanAt` say why a file cannot be downloaded yet.
- New configuration: `FILE_STORAGE_DIR` and `CLAMAV_ADDRESS` (both required on `prod`), `JOBS_INTERVAL_SECONDS` (default 30). New permissions: `forms.read`, `forms.manage`, `submissions.read`, `held_mail.manage`.
- New migrations, in order: `20261017080000_listed_sites_check`, `20261017090000_forms_and_intake`, `20261018090000_form_token_renewal`, `20261018120000_form_token_refused`, `20261018130000_files_external_links`, `20261018140000_form_versions_publisher`, `20261018150000_held_mail_numbers`.
- Tests: intake end to end (ST-31, ST-34, ST-35, ST-41); uploads, scans and downloads, and the authorisation matrix over the routes of 0.3.0 (ST-32, ST-33, ST-38, ST-39, ST-65); the edge probes, the abstract-form checklist and files that lie (M3-QA-02, M3-QA-03).

### Changed

- The audit log keeps no bank account number (owner decision D9): `rsdAccount` and `eurIban` are recorded by name only, and entries written before are shown without their values (M2-ISS-16).
- The descriptions of `PublicFormDto.closedReason` (UX3-03) and of a deadline's inclusive `endsOn` and exclusive `endsAt` (UX3-08).
- The link of an invitation, a reset and an email change "works once and expires in" its lifetime, in English and Serbian (UXUI-M2-37).
- The descriptions of the conference states name the actions "Open for submissions" and "Close submissions" (D10, M2-ISS-15).
- Committed contracts write invisible characters as escapes.
- `.env.example` lists the tool variables `STUBS_PORT` and `PROVISION_DATABASE_URL` (FIN2-08, M2-ISS-23).
- The unit tier guards PDF renders against a hang only (30 s); the 5 s of NFR-PERF-03 is held by the timing tier. The README gives the measured durations of `test:int` and `test:e2e` on a quiet and on a loaded machine.

### Fixed

- The findings of the 0.3.0 verification: the proof-of-work is decided at the submit as well (Q3-02), asked for by acts of a script and not by the volume of one address, at 13 bits instead of 16 (Q3-08); an IPv6 client is its /64 (Q3-03); a refused upload uses none of the token's uploads (Q3-04); a broken upload leaves no temporary file, and temporary files count against the quota (Q3-05); the 100th confirmation to a domain goes out, the 101st is held (Q3-06); a fake success carries the edition and answers a repeat of its key alike (Q3-07); a `.docx` is found to hold macros by the content type and relationship of its VBA project (Q3-11).
- A renewal counts the minimum fill time from the start of its chain, and a token renewed once renews nothing again (row lock), so two renewals cannot skip the 3 s (Q3-14).
- A repeat of a fake success's key counts as an act of a script, so a page that sends the trap three times under one key is asked for a proof-of-work (UX review of 0.3.0).
- Every form version names its publisher: `form_versions.published_by` is `NOT NULL` (the contract already said `publishedBy` is never null), and `seed:e2e` publishes its form as the seeded admin. A development database seeded before this fix is refused by `db:migrate` with a hint: `stack:wipe` and seed again (blank-slate run 2).
- A test holds that a confirmed email change ends a second confirmation that waits, queued or for a server, in the change's own transaction (FIN2-02, M2-ISS-22).

### Security

- **SEC-M3-01** (high): the inspection of a `.docx` is bounded: per file at most 64 parts read, 2 MB inflated in all and 1 s; a ZIP whose entries repeat a name (in any casing) or overlap is refused (415); more than the budget counts as macros (422); either refusal counts as an act of a script.
- **SEC-M3-02**: a chain of token renewals ends 24 hours after it began; a live token is never renewed (new column `form_tokens.refused_at`); the files of an expired token are purged once its chain has ended, any unattached file 30 hours after its upload; one client keeps at most 1 GB of uploads in 30 hours, half the quota of an organisation (429).
- **SEC-M3-03** (the answer to M3-ISS-03): a title whose shown text holds a bare domain (`evil.com`, `x.com:8080/a`, Cyrillic domains) is left out of the confirmation, which then names the reference only; the form keeps accepting such titles.
- **SEC-M3-04**: a token used by a submission, a fake success or a renewal renews nothing.
- **SEC-M3-05**: the purge deletes the row first, on its conditions checked again on the locked row, and the bytes only when exactly that row went.
- **SEC-M3-06**: the macro check reads parts as Word does (UTF-8 or UTF-16, character references and named entities decoded; a part that is neither counts as macros), compares the storage names of an old `.doc` in any casing, and keeps a `.docx` whose relationships reach outside it (remote template, frame or object; a UNC or `file:` target) flagged `external_links`.
- **SEC-M3-07**: the trap field is `confera_hp`, a name no autofill fills; the 0.3.0 name `website` is still read as a deprecated alias.
- **SEC-M3-09**: the comment of `clientKey` says what it does with an embedded IPv4 tail; the code is unchanged.
- **SEC-M3-11** (high): relationship parts are read by a linear scan by character codes, with no regular expression over a part; at most 10 000 elements of at most 16 KB each, the time budget looked at between elements; the 100 ms gate on 1 MB adversarial parts is in the timing tier.
- A listed site is refused with a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`) outside `STAGE=local`; the column itself checks that every entry is a canonical origin, at most 20; the frame list is checked once more when it is read (SEC-M2-12, M2-ISS-21).
- M3-ISS-07 (the snippet's inline lines at up to 800 characters) was accepted by the Security reviewer of 0.3.0; no change here.

### Known gaps

Open rows of "Issues logged during 0.1.0" in the milestone plan:

- M3-ISS-01 (info): the development stack has no ClamAV; the client is real, the tests use a fake daemon of the same protocol. To 0.4.0, real ClamAV on staging.
- M3-ISS-02 (low): SEC-M2-05, no cap on the test messages of a mail server. To 0.4.0.
- M3-ISS-04 (decision): the defaults built in 0.3.0 (breaker 30 an hour and 200 a day per form and per organisation, 100 a day per recipient domain; form tokens 6 hours; minimum fill time 3 s; the unattached-files quota per organisation) are confirmed at Gate 3.
- M3-ISS-06 (info): production keeps Next's 10 MB proxy body limit, so the reverse proxy must send `/public/v1` straight to the API. To 0.4.0, staging topology.
- M3-ISS-08 (low): the frame page has no loading state inside the frame; M2-ISS-17 items 31, 32, 34, 36, 39 and M2-ISS-18 are still open. To 0.4.0.
- M3-ISS-09 (low, Q3-12 rest): in WebKit on a site with CSS `zoom` the frame leaves blank room below the form and cuts its right fifth. To 0.4.0, real Safari on staging.
- M3-ISS-10 (info, Q3-13 and Q3-08): form load (NFR-PERF-01) and the proof-of-work cost are measured only, not judged; staging measurement and real Safari.
- M3-ISS-11 (low, Q3-08 rest): the form-wide proof-of-work trigger stays at more than 20 submissions in 10 minutes. To 0.4.0 or staging data.
- M3-ISS-12 (info, SEC-M3-11 rest): an unterminated `<!--` in a 1 MB part scans in 147 ms; add that shape to the 100 ms gate of `test:timing`. To 0.4.0.
- M3-ISS-13 (low, UX3 rest): backend texts: "Vi" capitalisation in the seeded thank-you, the conference name not declined in the Serbian confirmation. To 0.4.0.
- M3-ISS-14 (medium, UX3-06 rest): held mail can only be released, not discarded. To 0.4.0, with the status model.
- M3-ISS-15 (low, D7): there is no conference contact, so without an organisation contact email the closed form names nobody to write to. To 0.4.0 or Gate 3.
- M3-ISS-16 (low): a freshly seeded form already shows "draft has unpublished changes" in the admin. To 0.4.0.
- Not fixed, from the reviews: SEC-M3-08 (info: a bot can tell a fake success from a real one) and SEC-M3-10 (info: the scanner gaps of SEC-M2-09, carried to 0.4.0).

## [0.2.0] - 2026-10-16

### Added

- Users, the two roles and their permissions seeded by migration; every route declares a permission or that it is public, and the application does not start otherwise; the authorisation matrix is generated from the OpenAPI file for five actors (M2-BE-01).
- Sign-in and sessions (ADR-03): a `__Host-` cookie with a random token stored as its SHA-256, a new token at every sign-in, a session-bound CSRF header, an exact Origin check, 24 hours without use and 7 days at the latest, every ending event, the password asked again valid for 5 minutes, the brake per account and per address with the known-device cookie and a limited notice, equal answers in body and time, the one-hop client address, the second-factor step of 0.9.0 in the model (M2-BE-02).
- The password rule set of Gate 2 (12 characters, not common or leaked, not an own or the organisation's name, both entries match), enforced by the server with each broken rule named, and exported with 37 vectors as `contracts/password-rules.json` (M2-BE-02, ST-62).
- Secure links for invitations, password resets and email changes (ADR-04): one purpose per endpoint, opened by GET and used up by POST, a newer link revoking the older, a cool-down and a daily cap for resets, no reset for invited or deactivated accounts, and a mail outbox that stores which link a message needs, never the link (M2-BE-03).
- User administration with the last-admin rule, versions against two admins editing at once, removed users kept for attribution, the password asked again and a notice to every active admin for each change (M2-BE-04); the own password and email change, the latter confirmed from the new address.
- The organisation profile with the issuer data and the payment details (bank accounts and IBAN checked), the latter with the password again and a notice to all admins, and who changed them when (M2-BE-05).
- The audit log, insert-only for both run-time roles, with old and new values only for the fields on the list in code; security events of the instance with the summed entry of failed sign-ins for unknown addresses (M2-BE-06).
- `POST /public/v1/csp-reports` for the reports of the web application's content security policy, with a size limit, a rate limit and no personal data kept (M1-ISS-11).
- `@node-rs/argon2` for the password hashes (argon2id, 19 MiB, 2 passes).
- Mail servers (ADR-11; M2-BE-07): a default and a fallback per organisation, the password write-only and sealed (AES-256-GCM under `DATA_KEY`, bound to its row), cleared when host, port, user or TLS mode change; TLS required (implicit or STARTTLS, TLS 1.2, verified certificate), no TLS only on developer stages; in production no loopback, private or container address and the mail ports only; a test message with a generic answer; every change with the password again and a notice to all admins (ST-19, ST-20). `DATA_KEY` is a new required secret.
- The outbox worker and the mail log (ADR-13; M2-BE-08): due rows claimed inside their organisation so a message goes once, the template chosen by conference and language, the servers in the order of FR-SMTP-02 with the fallback, the secure link minted at send time and logged as `[link]`, a send rate per server, backoff and five attempts, interrupted rows flagged `stuck`; one structured recipient; the log's content can be switched off per organisation; `GET /api/v1/mail-log`. `MAIL_WORKER_INTERVAL_SECONDS` (default 5). nodemailer 10.1.0.
- Conferences (FR-CONF-01 to 04; M2-BE-09): create, change, state, copy; codes unique per organisation and edition; listed sites kept as origins and refused with a wildcard, path, query, user part, space, semicolon or a 21st entry, `https` only outside `STAGE=local` (ST-30); time zone and languages.
- The template document format (ADR-12; M2-BE-10): a closed set of nodes checked on save and again at render, a serialiser to HTML and plain text, the placeholder catalogue per type, `contracts/template-vectors.json` with refused and rendered vectors (ST-58, ST-22); default templates of seven types in English and Serbian; `GET /api/v1/mail-templates` and its catalogue.
- `pnpm seed:production` (the organisation, its templates and the five conferences as drafts, no user) and `pnpm first-admin` (an invitation only, its link printed once to the terminal) (M2-BE-11, ST-27).

- Edge cases and hardening found by the Test engineer and the edge-case hunter: every database session runs in UTC and the start-up check refuses one that does not, so no expiry moves with the time zone of the database server; listed sites are stored only as canonical origins (no percent-escape or look-alike that becomes `;`, `,` or `'`); every IPv6 spelling of a mail target, and every address a name resolves to, is checked as one address; a delivery has a total deadline of 45 s; one default and one fallback mail server per organisation, held by partial unique indexes; a queued message with a link is checked again at send time (address and state of the account); odd input answers 4xx (a NUL in an address, a body nested deeper than 64 levels, null for a field that has none, odd audit dates); a removed user cannot be changed (409 `user_removed`); passwords are hashed and checked in NFC; at most five email changes a day; two confirmations of one address at once answer 409; the version of `DELETE /users/{id}` is in the OpenAPI document; `first-admin` uses the address rule of the application; any time zone the runtime knows is accepted.
- A message that no mail server can send waits as `waiting_for_server` and goes out once a server is added or changed, with its link made then; `UserDto.invitationDelivery` says what became of an invitation (`queued`, `waiting_for_server`, `sent`, `failed`) (UXUI-M2-01). A mail server that can never send (no TLS to another machine, a port or an address the policy refuses) is refused when it is saved, with the field named (UXUI-M2-10).
- The Security reviewer's conditions: a password change, a reset or an email change ends every open link and every queued message that would make one, and the sender refuses a link message from before the last password change (SEC-M2-01); the password asked again is braked by the address and by its own failures (SEC-M2-02); tests that hold the check of resolved addresses, the TLS 1.2 minimum and the fail-closed IPv6 rule (SEC-M2-13).
- Tests: the authorisation matrix covers every route of the admin API; an after-run scan of the whole end-to-end run for live tokens and personal data (M2-QA-01, ST-17); the edge cases of 0.2.0 (M2-QA-03, E2-01 to E2-16).

### Changed

- Mailpit of the development stack greets at once (`MP_SMTP_DISABLE_RDNS`): a test mail no longer waits 8 s.
- The time band of ST-16 compares the median answer of each kind within 150 ms, over interleaved rounds: reliable under load, and a slower path for a known account fails it.
- The order of the values of every enum in the OpenAPI document is fixed by the code, not by the compiler.
- `seed:e2e` gives each invented person the invented password of `test/e2e/seed/e2e-seed.json` (they are active and can sign in, for the sign-in tests of the web application) and writes the default email templates; still only on `STAGE=local` or `test`.
- Secret scanner 1.1.0 (M1-ISS-01, M1-ISS-03 to M1-ISS-07, the Security reviewer's proviso M1-ISS-17): a literal handed to a call where it takes a key or a secret (`cookieParser('x')`, `jwt.sign(p, 'x')`, `createHmac(alg, 'x')`, `createCipheriv(alg, 'x', iv)`, `new SignJWT(...).sign(new TextEncoder().encode('x'))` and the other calls of the written list) is a finding; so is a literal through a conversion (`Buffer.from('x')`), a name declared with a literal in the same file, and a literal compared with a secret-like name. Every text of JavaScript and every text value of JSON is read as lines of a shell (`execSync('PGPASSWORD=x ...')`, a script of `package.json`), and every line of a shell is cut into commands at `&&`, `||`, `;` and `|`, which also reads a continued `RUN` of a Dockerfile. `$(echo x)`, `$(printf x)` and PowerShell's `ConvertTo-SecureString 'x'` count as the literal they print. In the maps of dependencies only a version specifier is an exception, and only at the top of a manifest; `compilerOptions.paths` of a tsconfig and the patch paths of `patchedDependencies` are no longer findings. A file larger than 2 MB is reported instead of skipped. The rule in the README says what the scan does not see.
- The limit of an API start, or a refused start, in the integration tests is 120 s instead of 30 s: a guard against a process that hangs, not an assertion of speed, which the timing tier holds; a loaded machine no longer fails them for the wrong reason (M1-ISS-43).
- One development stack per checkout (M1-ISS-13): the Docker Compose project is named after the folder of the checkout (`confera-<folder>-<hash>`, or `CONFERA_STACK_NAME`), so containers and the database volume are its own; the ports come from `.env` (the port of the database addresses, `CONFERA_MAIL_WEB_PORT`, `CONFERA_MAIL_SMTP_PORT`), and `pnpm stack:ports` writes a free set derived from the checkout. `stack:up` refuses a port of another checkout's stack or of another program; `db:provision`, `db:migrate`, `db:status`, `db:diff`, `seed:e2e`, `start`, `start:dev`, `test:int` and `test:e2e` refuse a database that another checkout's stack (or a container of no Confera stack) serves, before they connect. New: `stack:wipe`, `stack:ports`, `stack:info`. The shared project `confera` and volume `confera_pgdata` of 0.1.0 are no longer used.

## [0.1.0] - 2026-10-14

### Added

- Scaffold of the API: NestJS 12, Prisma 7, strict TypeScript 6.0.3, pnpm 11 through corepack.
- Configuration module with a schema: a missing or invalid variable stops the start and is named.
- `pnpm check`: formatting, lint with security rules, typecheck, tests, builds and supply-chain checks.
- Development stack in Docker: PostgreSQL 18 and Mailpit, images referenced by digest.
- STAGE and INSTANCE guard; the dev-tools module exists only in the development build.
- `GET /health` and `GET /api/v1/meta`; the admin API answers only under the admin host name.
- One error format (`application/problem+json`); an unknown error answers with a code and a trace id only.
- JSON log with redaction by field name; the request log holds the route, never the address.
- OpenAPI files generated from the code and committed in `openapi/`, with a drift check and a schema lint.
- Database roles and provisioning script; first migration with row-level security on every tenant table.
- Tenant database client (every operation inside the organisation of the request), resolvers of the system role, start-up check of the database roles, `GET /health/ready`.
- Integration tests against PostgreSQL in Docker (`pnpm test:int`): tenant isolation, catalogue check, roles, clean production start.
- PDF renderer on pdfmake with embedded Manrope and Noto Sans, glyph check, ligatures off; bilingual sample (`pnpm pdf:sample`).
- End-to-end tests of the API (`pnpm test:e2e`): supertest against the real application on PostgreSQL in Docker as the application role, with factories for invented people.
- `pnpm seed:e2e` (refuses to run outside the stages local and test) and `pnpm stubs`, the stub slot of the development stack.
- `pnpm test:supply-chain`, part of `pnpm check`: planted fake secrets, a vulnerable package and an unlisted build script must each be caught.
- Cross-repo smoke test (M1-QA-02): the browser tests of `confera_fe` run in front of this API, started by the commands of README section 9 and nothing else.
- PDF timing gate: the middle one of five fresh processes must make each kind of document in under 5 seconds (not the fastest one).
- Architecture tests: who reads the environment (syntax tree), no credential compared with a configuration value, no `DEV_` key in a compose or deploy file.

### Fixed

- The surface of a request is chosen by an exact match of a syntactically valid `Host` header against the configured host names; a header with a user part, a path, a query or an encoded character is not found.
- The secret scan also reports every literal value bound to a secret-like name (decided by the last word of the name: password, pass, passphrase, secret, token, credentials, a key of an API and the like, with qualifier words such as `_SANDBOX` after it), in every syntax where a name gets a value: `NAME=value` lines and `-e NAME=value` arguments, YAML, JSON, JavaScript and TypeScript, also in UTF-16 files. Empty values, references and placeholders that start with `invented-` or `local-only-` are the only allowed values; there is no guess by length; three narrow exceptions are written down. The scanner (version 1.0.0), its two corpora and a manifest of their hashes are in `scripts/secret-assignments/`.
- PDF: the glyph check covers every place where text can enter a document (page background, title of a table of contents, list separators); what cannot be checked (SVG images, sections, attachments, text references, fill patterns, unknown kinds) is refused.
- PDF: the fonts are loaded once, from memory, with their ligature features removed, so the PDF library no longer shapes every text without its cache; a table of 200 rows renders three to four times faster. The 5-second criterion is asserted by `pnpm test:timing`, a step of its own in `pnpm check`: fresh processes of plain Node, the first document included.
- A start that the configuration refuses ends before the framework and the application are loaded (`src/startup.ts`): it runs no application code and costs a tenth of the time, which the tests of the built application depend on when the machine is busy.
- The start-up role check follows every chain of memberships (`pg_has_role(..., 'MEMBER')`, so a membership that only allows `SET ROLE` counts too): the application role is refused when it can reach a role that is a superuser, may bypass row-level security (the system role among them) or may create roles or databases; the system role when it can reach a superuser or a role that may create roles or databases. Both are refused as members of a predefined role of PostgreSQL: the 15 of PostgreSQL 18 that are memberships (from `pg_read_server_files` to `pg_create_subscription`, each with its reason), and any `pg_` role of a later version until it is decided; `pg_database_owner`, the 16th, is ownership and refused as such. The API exits with 77 (E1).
- On the stages `local`, `dev` and `test` the API listens on a loopback address only: `LISTEN_HOST` must be in 127.0.0.0/8, `::1` or `localhost`, otherwise the start is refused with exit code 78 before the framework is loaded. `prod` is unchanged (E2).
- A database that accepts connections and never answers is not waited for: a new connection may take 10 s, the start-up role check 20 s in all (then exit code 77), and `GET /health/ready` answers 503 when `SELECT 1` has not come back within 5 s; readiness answers 200 again by itself when the database does. `GET /health` never asks the database (E5).
- PDF: a run of more than 24 letters without a space is cut into pieces of 12 before pdfmake sees it (one word of 3 000 letters in a narrow column took 56 s on the event loop, now well under a second), and a document with more than 30 000 characters of text is refused with `PdfTooLargeError`. The timing tier also measures the long word (E6).
- `db:provision` holds an advisory lock on the server for its whole run, so two runs at once wait for each other instead of failing with "tuple concurrently updated"; a database that an interrupted `DROP DATABASE` left invalid is dropped and created again; a run whose connection breaks (PostgreSQL restarted or still starting) starts again by itself, up to three times; a failure is one sentence that names what happened and its error code (E8).
- README: the clone names its branch (`main` the latest release, `develop` the work in progress), with `confera_be` and `confera_fe` side by side in one folder; `db:migrate` ends with one of two sentences, both success; the cross-repo smoke test starts the frontend's three servers before it asks `/health/ready`, so the API is started first; exit codes, test tiers, layout and the things a newcomer trips over brought up to date with the fixes above.
