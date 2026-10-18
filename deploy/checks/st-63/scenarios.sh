#!/bin/bash
# ST-63 as far as it can be proven without a server (M4-BE-08): run inside the test container
# of deploy/checks/st-63/Dockerfile by deploy/checks/deploy-gate.mjs.
#
# An SSH server configured by deploy/server/ (sshd snippet, forced command, sudoers rule, deploy
# script), a key per repository, and a stand-in for docker that records every call. Proves:
#   - a deploy key hands over a digest and the deploy script pulls exactly <fixed repo>@<digest>;
#   - anything but a digest is refused, and nothing reaches docker;
#   - the deploy key cannot open a shell, a terminal, a forward, sftp or scp;
#   - the key of one repository cannot deploy the other repository's image;
#   - the deploy user can run nothing as root but the deploy script, which checks again;
#   - the deploy script refuses an image that names no jobs image of the fixed repository,
#     an unsafe configuration, and leaves the running version alone on a failed migration;
#   - before every migration it dumps the database (custom format, root 0600) and reads the dump
#     back with pg_restore --list; a failed, empty or unreadable dump, or a disk fuller than the
#     limit, stops it before the migration with nothing changed (SEC-M4I-02);
#   - a new version that does not become healthy is rolled back to the previous digest.
# Prints one line per check and ends with exit code 0 only if every check passed.
set -uo pipefail

passed=0
failed=0
ok() { printf 'ok    %s\n' "$1"; passed=$((passed + 1)); }
not_ok() { printf 'FAIL  %s\n' "$1"; failed=$((failed + 1)); }

DIGEST="sha256:$(printf 'a%.0s' {1..64})"
JOBS_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
LOG=/var/log/fake-docker.log

# ---- Set up: host keys, the two deploy keys, sshd ---------------------------------------------
for who in be web; do
  su tester -c "ssh-keygen -q -t ed25519 -N '' -C 'confera_$who pipeline' -f /home/tester/$who"
  printf 'restrict,command="/usr/local/sbin/confera-deploy-gate %s" %s\n' "$who" "$(cat /home/tester/$who.pub)" \
    >/etc/ssh/confera-deploy/confera-deploy-$who.keys
  chmod 0644 /etc/ssh/confera-deploy/confera-deploy-$who.keys
done
# A shell account with a key of its own, to show that the server does open shells: the refusals
# below are the deploy users' configuration, not a server without shells.
su tester -c "ssh-keygen -q -t ed25519 -N '' -f /home/tester/own"
install -d -o tester -g tester -m 0700 /home/tester/.ssh
install -o tester -g tester -m 0600 /home/tester/own.pub /home/tester/.ssh/authorized_keys
printf 'ghcr.io/stojanivanisevic/confera-be-jobs@%s' "$JOBS_DIGEST" >/etc/fake-docker/label
# The jobs image holds three migrations, and the database has applied the same three.
printf '%s\n' 20261013070000_tenancy_foundation 20261014120000_access_and_audit 20261015090000_mail_and_conferences \
  >/etc/fake-docker/image-migrations
cp /etc/fake-docker/image-migrations /etc/fake-docker/applied-migrations
# Keys for root and for a user outside confera-ssh: sshd must refuse both.
install -d -m 0700 /root/.ssh
install -m 0600 /home/tester/own.pub /root/.ssh/authorized_keys
install -d -o outsider -g outsider -m 0700 /home/outsider/.ssh
install -o outsider -g outsider -m 0600 /home/tester/own.pub /home/outsider/.ssh/authorized_keys
: >"$LOG"
chmod 0644 "$LOG"
/usr/sbin/sshd -E /var/log/sshd.log

as_tester() { su tester -c "$1"; }
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5"
# send <key> <request> [ssh options...]: the request travels as one argument, byte for byte.
send() {
  local key=$1 request=$2
  shift 2
  printf '%s' "$request" >/tmp/request
  chmod 0644 /tmp/request
  as_tester "ssh $SSH_OPTS $* -i /home/tester/$key -- confera-deploy-$key@127.0.0.1 \"\$(cat /tmp/request)\""
}
# raw <key> [ssh options and arguments...]
raw() {
  local key=$1
  shift
  as_tester "ssh $SSH_OPTS -i /home/tester/$key $* confera-deploy-$key@127.0.0.1"
}

calls() { wc -l <"$LOG"; }

# ---- A digest is deployed, from the fixed repository only --------------------------------------
: >"$LOG"
rm -f /srv/confera/images.env /srv/confera/images.env.previous
out=$(send be "$DIGEST" 2>&1)
code=$?
if [ "$code" -eq 0 ] && grep -qx "pull --quiet ghcr.io/stojanivanisevic/confera-be@$DIGEST" "$LOG"; then
  ok "be key + digest: pulls ghcr.io/stojanivanisevic/confera-be@<digest>"
else
  not_ok "be key + digest: exit $code; $out"
fi
grep -qx "pull --quiet ghcr.io/stojanivanisevic/confera-be-jobs@$JOBS_DIGEST" "$LOG" &&
  ok "be: pulls the jobs image the API image names, by digest" || not_ok "be: jobs image not pulled"
grep -q " run --rm --no-TTY migrate$" "$LOG" && ok "be: runs the migration job" || not_ok "be: no migration"
grep -q " up --detach --no-deps --wait --wait-timeout 240 api worker$" "$LOG" &&
  ok "be: restarts api and worker and waits for health" || not_ok "be: no restart of api and worker"
grep -q " exec --no-TTY api node -e " "$LOG" && ok "be: smoke test of readiness" || not_ok "be: no smoke test"
if grep -qx "CONFERA_API_IMAGE=ghcr.io/stojanivanisevic/confera-be@$DIGEST" /srv/confera/images.env &&
  grep -qx "CONFERA_JOBS_IMAGE=ghcr.io/stojanivanisevic/confera-be-jobs@$JOBS_DIGEST" /srv/confera/images.env; then
  ok "be: images.env names both images by digest"
else
  not_ok "be: images.env is $(cat /srv/confera/images.env 2>&1)"
fi
line_of() { grep -n -m 1 -e "$1" "$LOG" | cut -d: -f1; }
dump_line=$(line_of ' exec --no-TTY postgres pg_dump --username postgres --dbname confera --format custom')
list_line=$(line_of ' exec --no-TTY postgres pg_restore --list')
migrate_line=$(line_of ' run --rm --no-TTY migrate$')
if [ -n "$dump_line" ] && [ -n "$list_line" ] && [ -n "$migrate_line" ] &&
  [ "$dump_line" -lt "$list_line" ] && [ "$list_line" -lt "$migrate_line" ]; then
  ok "be: dumps the database (pg_dump -Fc) and reads the dump back (pg_restore --list) before the migration"
else
  not_ok "be: dump $dump_line, check $list_line, migration $migrate_line: $(cat "$LOG")"
fi
dumps=(/srv/confera/backups/pre-deploy-*Z-aaaaaaaaaaaa.dump)
if [ "${#dumps[@]}" -eq 1 ] && [ -s "${dumps[0]}" ] && [ "$(stat -c '%U %a' "${dumps[0]}")" = "root 600" ] &&
  [ "$(stat -c '%U %a' /srv/confera/backups)" = "root 700" ] && ! ls /srv/confera/backups/*.partial >/dev/null 2>&1; then
  ok "be: the dump is backups/pre-deploy-<UTC>-<12 hex>.dump, root 0600, in a root 0700 folder"
else
  not_ok "be: dumps ${dumps[*]}: $(ls -la /srv/confera/backups 2>&1)"
fi
[[ "$out" == *"backup /srv/confera/backups/pre-deploy-"*".dump"* ]] && ok "be: the output names the dump" ||
  not_ok "be: the dump is not named in the output: $out"
if grep -Eq 'confera-web|--privileged|-v |--volume|/bin/sh|bash' "$LOG"; then
  not_ok "be: docker was asked for something else: $(cat "$LOG")"
else
  ok "be: docker was asked for nothing but pull, inspect, compose and the migration list"
fi
if grep -qx "run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --entrypoint ls ghcr.io/stojanivanisevic/confera-be-jobs@$JOBS_DIGEST /app/prisma/migrations" "$LOG" &&
  grep -q " exec --no-TTY postgres psql .*_prisma_migrations" "$LOG"; then
  ok "be: compares the jobs image's migrations (no network, read-only) with _prisma_migrations"
else
  not_ok "be: no comparison of the migrations: $(cat "$LOG")"
fi

: >"$LOG"
out=$(send web "$DIGEST" 2>&1)
code=$?
if [ "$code" -eq 0 ] && grep -qx "pull --quiet ghcr.io/stojanivanisevic/confera-web@$DIGEST" "$LOG" &&
  ! grep -q 'confera-be' "$LOG" && grep -q " up --detach --no-deps --wait --wait-timeout 240 web$" "$LOG"; then
  ok "web key + digest: pulls ghcr.io/stojanivanisevic/confera-web@<digest> and restarts web only"
else
  not_ok "web key + digest: exit $code; $out; $(cat "$LOG")"
fi
grep -q ' pg_dump \| migrate$' "$LOG" && not_ok "web: dumped or migrated: $(cat "$LOG")" ||
  ok "web: no dump and no migration (the web target has no database)"

# ---- Anything but a digest is refused, and nothing reaches docker ------------------------------
hex64=$(printf 'c%.0s' {1..64})
refused_requests=(
  ""
  "sha256:"
  "sha256:abc"
  "sha256:${hex64:0:63}"
  "sha256:${hex64}c"
  "SHA256:${hex64}"
  "sha256:$(printf 'C%.0s' {1..64})"
  "sha256:$(printf 'g%.0s' {1..64})"
  "sha512:${hex64}${hex64}"
  "${hex64}"
  "ghcr.io/stojanivanisevic/confera-be@sha256:${hex64}"
  "ghcr.io/stojanivanisevic/confera-be:latest"
  "confera-be:0.4.0"
  "latest"
  "sha256:${hex64} sha256:${hex64}"
  "sha256:${hex64} --privileged"
  "sha256:${hex64};id"
  "sha256:${hex64}&&id"
  "sha256:${hex64}|id"
  "sha256:${hex64}\$(id)"
  "\$(id)"
  "\`id\`"
  "sha256:${hex64} "
  " sha256:${hex64}"
  "--help"
  "-v"
  "/bin/sh"
  "bash -i"
  "sh -c id"
  "internal-sftp"
  "scp -t /tmp"
  "rsync --server ."
  "docker ps"
)
for request in "${refused_requests[@]}"; do
  : >"$LOG"
  out=$(send be "$request" 2>&1 </dev/null)
  code=$?
  if [ "$code" -eq 64 ] && [ "$(calls)" -eq 0 ] && [[ "$out" == *"refused"* ]]; then
    ok "refused, nothing ran: [$request]"
  else
    not_ok "not refused: [$request] exit $code calls $(calls): $out"
  fi
done

# A digest followed by a newline and a command (the request arrives in one variable).
: >"$LOG"
out=$(send be "$(printf '%s\nid' "$DIGEST")" 2>&1 </dev/null)
code=$?
[ "$code" -eq 64 ] && [ "$(calls)" -eq 0 ] && ok "refused, nothing ran: [digest + newline + id]" ||
  not_ok "digest + newline: exit $code: $out"

# ---- The deploy key opens no shell, no terminal, no forward, no file transfer -----------------
: >"$LOG"
out=$(as_tester "ssh $SSH_OPTS -tt -i /home/tester/be confera-deploy-be@127.0.0.1 </dev/null" 2>&1)
code=$?
[ "$code" -ne 0 ] && [ "$(calls)" -eq 0 ] && [[ "$out" != *"$ "* ]] &&
  ok "no shell: an interactive login with a terminal ends at once (exit $code)" ||
  not_ok "interactive login: exit $code: $out"
[[ "$out" == *"PTY allocation request failed"* ]] && ok "no terminal: the PTY request is refused" ||
  not_ok "PTY was not refused: $out"

: >"$LOG"
out=$(raw be -T 2>&1 </dev/null)
code=$?
[ "$code" -eq 64 ] && [ "$(calls)" -eq 0 ] && [[ "$out" == *"refused"* ]] &&
  ok "no shell: a login without a terminal runs the gate, which refuses (exit 64)" ||
  not_ok "login without terminal: exit $code: $out"

out=$(raw be -W 127.0.0.1:22 2>&1 </dev/null)
[[ "$out" == *"administratively prohibited"* || "$out" == *"open failed"* || "$out" == *"stdio forwarding failed"* ]] &&
  ok "no forwarding: a direct-tcpip (-W) channel is refused" || not_ok "-W: $out"

out=$(raw be -o ExitOnForwardFailure=yes -N -R 127.0.0.1:2222:127.0.0.1:22 2>&1 </dev/null)
[[ "$out" == *"forwarding failed"* || "$out" == *"remote port forwarding failed"* ]] &&
  ok "no forwarding: a remote forward (-R) is refused" || not_ok "-R: $out"

out=$(send be "sha256:x" -A -o ForwardAgent=yes 2>&1 </dev/null)
[[ "$out" == *"refused"* ]] && ok "an agent-forwarding request changes nothing (still only a digest)" || not_ok "-A: $out"

out=$(as_tester "sftp -b - $SSH_OPTS -i /home/tester/be confera-deploy-be@127.0.0.1 <<<'ls'" 2>&1)
code=$?
[ "$code" -ne 0 ] && [ "$(calls)" -eq 0 ] && ok "no sftp" || not_ok "sftp: exit $code: $out"

out=$(as_tester "scp $SSH_OPTS -O -i /home/tester/be /etc/hostname confera-deploy-be@127.0.0.1:/tmp/x" 2>&1)
code=$?
[ "$code" -ne 0 ] && [ ! -e /tmp/x ] && ok "no scp" || not_ok "scp: exit $code: $out"

out=$(as_tester "ssh $SSH_OPTS -o SendEnv=LD_PRELOAD -o SetEnv=SSH_ORIGINAL_COMMAND=$DIGEST -i /home/tester/be confera-deploy-be@127.0.0.1 id" 2>&1)
code=$?
[ "$code" -eq 64 ] && ok "the client cannot set the request through the environment" || not_ok "SetEnv: exit $code: $out"

out=$(as_tester "ssh $SSH_OPTS -i /home/tester/own tester@127.0.0.1 'echo shell-opens'" 2>&1)
[[ "$out" == *"shell-opens"* ]] && ok "control: the same server opens a shell for an ordinary key" ||
  not_ok "control: an ordinary key got no shell either; the checks above prove nothing: $out"

# ---- The hardening drop-in (sshd-confera-hardening.conf) --------------------------------------
out=$(as_tester "ssh $SSH_OPTS -i /home/tester/own root@127.0.0.1 'echo shell-opens'" 2>&1)
[[ "$out" != *"shell-opens"* && "$out" == *"Permission denied"* ]] &&
  ok "sshd: root cannot log in, even with a valid key" || not_ok "root login: $out"
out=$(as_tester "ssh $SSH_OPTS -i /home/tester/own outsider@127.0.0.1 'echo shell-opens'" 2>&1)
[[ "$out" != *"shell-opens"* && "$out" == *"Permission denied"* ]] &&
  ok "sshd: a user outside the group confera-ssh cannot log in, even with a valid key" ||
  not_ok "outsider login: $out"
out=$(as_tester "ssh $SSH_OPTS -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no tester@127.0.0.1 true" 2>&1)
[[ "$out" == *"Permission denied (publickey)"* ]] &&
  ok "sshd: no password or keyboard-interactive login; the server offers publickey only" ||
  not_ok "password login: $out"
settings=$(sshd -T 2>/dev/null)
for expected in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" \
  "allowgroups confera-ssh" "x11forwarding no" "allowtcpforwarding no" "permituserenvironment no"; do
  grep -qx "$expected" <<<"$settings" && ok "sshd -T: $expected" || not_ok "sshd -T has no line \"$expected\""
done

# ---- The deploy users can run nothing but the deploy script as root ---------------------------
out=$(su confera-deploy-be -c "sudo --non-interactive /bin/sh -c id" 2>&1)
[[ "$out" != *"uid=0"* ]] && ok "sudo: no shell as root for the deploy user" || not_ok "sudo /bin/sh: $out"
out=$(su confera-deploy-be -c "sudo --non-interactive /usr/local/sbin/confera-deploy web $DIGEST" 2>&1)
[[ "$out" != *"deployed"* ]] && ok "sudo: the be user cannot deploy the web target" || not_ok "be->web: $out"
: >"$LOG"
out=$(su confera-deploy-be -c "sudo --non-interactive /usr/local/sbin/confera-deploy be 'sha256:x --privileged'" 2>&1)
code=$?
[ "$(calls)" -eq 0 ] && [[ "$out" == *"refused"* ]] &&
  ok "the deploy script checks the digest itself, behind sudo" || not_ok "script behind sudo: exit $code: $out"
id confera-deploy-be | grep -q docker && not_ok "the deploy user is in the docker group" ||
  ok "the deploy user is not in the docker group"

# ---- The deploy script itself ------------------------------------------------------------------
printf 'ghcr.io/somebody-else/confera-be-jobs@%s' "$JOBS_DIGEST" >/etc/fake-docker/label
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
code=$?
[ "$code" -eq 65 ] && ! grep -q ' migrate$' "$LOG" &&
  ok "an image naming a jobs image of another repository is refused before the migration" ||
  not_ok "foreign jobs image: exit $code: $out"
printf 'ghcr.io/stojanivanisevic/confera-be-jobs:latest' >/etc/fake-docker/label
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
[ "$?" -eq 65 ] && ok "an image naming its jobs image by tag is refused" || not_ok "jobs by tag: $out"
printf 'ghcr.io/stojanivanisevic/confera-be-jobs@%s' "$JOBS_DIGEST" >/etc/fake-docker/label

cp /srv/confera/images.env /tmp/images.before
touch /etc/fake-docker/fail-migrate
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "sha256:$(printf 'd%.0s' {1..64})" 2>&1)
code=$?
rm -f /etc/fake-docker/fail-migrate
[ "$code" -eq 1 ] && ! grep -q ' up ' "$LOG" && cmp -s /tmp/images.before /srv/confera/images.env &&
  ok "a failed migration restarts nothing and leaves images.env as it was" ||
  not_ok "failed migration: exit $code: $out; $(cat "$LOG")"

grep -q '^confera-deploy: the database as it was before the migration: /srv/confera/backups/pre-deploy-' <<<"$out" &&
  ok "a failed migration names the dump taken before it" || not_ok "failed migration, no dump named: $out"

# ---- The backup before the migration (SEC-M4I-02) ----------------------------------------------
for failure in fail-dump empty-dump bad-dump; do
  cp /srv/confera/images.env /tmp/images.before
  count_before=$(find /srv/confera/backups -name '*.dump' | wc -l)
  touch "/etc/fake-docker/$failure"
  : >"$LOG"
  out=$(/usr/local/sbin/confera-deploy be "sha256:$(printf 'e%.0s' {1..64})" 2>&1)
  code=$?
  rm -f "/etc/fake-docker/$failure"
  if [ "$code" -eq 74 ] && ! grep -q ' migrate$' "$LOG" && ! grep -q ' up ' "$LOG" &&
    cmp -s /tmp/images.before /srv/confera/images.env && [[ "$out" == *"backup before the migration failed"* ]] &&
    [ "$(find /srv/confera/backups -name '*.dump' | wc -l)" -eq "$count_before" ] &&
    [ -z "$(find /srv/confera/backups -name '*.partial')" ]; then
    ok "$failure: stops before the migration (exit 74), keeps no file, images.env unchanged"
  else
    not_ok "$failure: exit $code: $out; $(cat "$LOG")"
  fi
done

cp /etc/confera/deploy.conf /tmp/deploy.conf
sed -i 's/^CONFERA_DISK_MAX_PERCENT=.*/CONFERA_DISK_MAX_PERCENT=0/' /etc/confera/deploy.conf
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
code=$?
cp /tmp/deploy.conf /etc/confera/deploy.conf
[ "$code" -eq 74 ] && [ "$(calls)" -eq 0 ] && [[ "$out" == *"% full"* ]] &&
  ok "a disk fuller than CONFERA_DISK_MAX_PERCENT stops a be deploy before anything runs (exit 74)" ||
  not_ok "full disk: exit $code calls $(calls): $out"

# ---- Rollback to the previous digest -----------------------------------------------------------
cp /srv/confera/images.env /tmp/images.before
touch /etc/fake-docker/fail-up-once
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "sha256:$(printf 'f%.0s' {1..64})" 2>&1)
code=$?
rm -f /etc/fake-docker/fail-up-once
ups=$(grep -c ' up --detach --no-deps --wait ' "$LOG")
if [ "$code" -eq 1 ] && [ "$ups" -eq 2 ] && cmp -s /tmp/images.before /srv/confera/images.env &&
  [[ "$out" == *"putting the previous version back"* ]] &&
  [[ "$out" == *"the database as it was before this deploy's migration: /srv/confera/backups/pre-deploy-"* ]]; then
  ok "a new version that is not healthy: images.env.previous is put back and restarted; the dump is named"
else
  not_ok "rollback: exit $code, $ups restarts: $out; $(cat /srv/confera/images.env)"
fi

# ---- Migrations never run backwards ----------------------------------------------------------------
# The database has applied a migration the image does not hold: the image is older.
cp /srv/confera/images.env /tmp/images.before
cp /etc/fake-docker/applied-migrations /tmp/applied.before
echo 20261016090000_one_default_mail_server >>/etc/fake-docker/applied-migrations
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "sha256:$(printf '9%.0s' {1..64})" 2>&1)
code=$?
cp /tmp/applied.before /etc/fake-docker/applied-migrations
if [ "$code" -eq 65 ] && ! grep -q ' pg_dump \| migrate$\| up ' "$LOG" && cmp -s /tmp/images.before /srv/confera/images.env &&
  [[ "$out" == *"older than the database"*"20261016090000_one_default_mail_server"*"confera-deploy rollback be"* ]]; then
  ok "an image older than the database is refused (exit 65) before the dump, the migration and any restart"
else
  not_ok "older image: exit $code: $out; $(cat "$LOG")"
fi
# A database that was never migrated (the first deploy) has no _prisma_migrations: allowed.
touch /etc/fake-docker/no-migrations-table
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
code=$?
rm -f /etc/fake-docker/no-migrations-table
[ "$code" -eq 0 ] && grep -q ' run --rm --no-TTY migrate$' "$LOG" &&
  ok "a database without _prisma_migrations (first deploy) is migrated" || not_ok "first deploy: exit $code: $out"

# ---- Rollback by the operator: one version back, no migration ------------------------------------
DIGEST2="sha256:$(printf '2%.0s' {1..64})"
rm -f /srv/confera/images.be.previous
out=$(/usr/local/sbin/confera-deploy be "$DIGEST2" 2>&1)
code=$?
[ "$code" -eq 0 ] && grep -qx "CONFERA_API_IMAGE=ghcr.io/stojanivanisevic/confera-be@$DIGEST" /srv/confera/images.be.previous &&
  [ "$(stat -c '%U %a' /srv/confera/images.be.previous)" = "root 644" ] &&
  ok "a deploy records the target's version before it in images.be.previous" ||
  not_ok "images.be.previous after a deploy: exit $code: $out; $(cat /srv/confera/images.be.previous 2>&1)"
web_before=$(grep '^CONFERA_WEB_IMAGE=' /srv/confera/images.env)
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy rollback be 2>&1)
code=$?
if [ "$code" -eq 0 ] && grep -qx "CONFERA_API_IMAGE=ghcr.io/stojanivanisevic/confera-be@$DIGEST" /srv/confera/images.env &&
  [ "$(grep '^CONFERA_WEB_IMAGE=' /srv/confera/images.env)" = "$web_before" ] &&
  ! grep -q ' migrate$\| pg_dump \|^pull \|^run ' "$LOG" &&
  grep -q ' up --detach --no-deps --wait --wait-timeout 240 api worker$' "$LOG" &&
  grep -q ' exec --no-TTY api node -e ' "$LOG"; then
  ok "rollback be: back to the previous digest, api and worker restarted and smoke-tested, NO migration, no pull, web untouched"
else
  not_ok "rollback be: exit $code: $out; $(cat "$LOG"); $(cat /srv/confera/images.env)"
fi
grep -qx "CONFERA_API_IMAGE=ghcr.io/stojanivanisevic/confera-be@$DIGEST2" /srv/confera/images.be.previous &&
  ok "after a rollback, images.be.previous holds the version rolled back from" ||
  not_ok "images.be.previous after the rollback: $(cat /srv/confera/images.be.previous)"
cp /srv/confera/images.env /tmp/images.before
touch /etc/fake-docker/fail-up-once
out=$(/usr/local/sbin/confera-deploy rollback be 2>&1)
code=$?
rm -f /etc/fake-docker/fail-up-once
[ "$code" -eq 1 ] && cmp -s /tmp/images.before /srv/confera/images.env &&
  ok "a rollback whose version is not healthy puts the current version back (exit 1)" ||
  not_ok "failed rollback: exit $code: $out; $(cat /srv/confera/images.env)"
out=$(/usr/local/sbin/confera-deploy rollback web 2>&1)
code=$?
[ -f /srv/confera/images.web.previous ] && not_ok "web has a previous version unexpectedly" ||
  { [ "$code" -eq 64 ] && [[ "$out" == *"no previous version of web"* ]] &&
    ok "rollback without a recorded previous version is refused (exit 64)" || not_ok "rollback web: exit $code: $out"; }
printf 'CONFERA_API_IMAGE=ghcr.io/somebody-else/confera-be@%s\nCONFERA_JOBS_IMAGE=ghcr.io/stojanivanisevic/confera-be-jobs@%s\n' \
  "$DIGEST" "$JOBS_DIGEST" >/tmp/foreign.previous
cp /srv/confera/images.be.previous /tmp/be.previous
cp /tmp/foreign.previous /srv/confera/images.be.previous
: >"$LOG"
out=$(/usr/local/sbin/confera-deploy rollback be 2>&1)
code=$?
cp /tmp/be.previous /srv/confera/images.be.previous
[ "$code" -eq 78 ] && [ "$(calls)" -eq 0 ] && ok "rollback refuses a recorded image of another repository" ||
  not_ok "foreign rollback: exit $code: $out"
: >"$LOG"
out=$(su confera-deploy-be -c "sudo --non-interactive /usr/local/sbin/confera-deploy rollback be" 2>&1)
[ "$(calls)" -eq 0 ] && [[ "$out" != *"rolled back"* ]] &&
  ok "the deploy user cannot start a rollback (sudo allows <target> sha256:... only)" || not_ok "deploy user rollback: $out"
: >"$LOG"
out=$(send be "rollback" 2>&1 </dev/null)
[ "$?" -eq 64 ] && [ "$(calls)" -eq 0 ] && ok "a deploy key cannot start a rollback" || not_ok "key rollback: $out"

# ---- The nightly backup (confera-backup) ----------------------------------------------------------
touch -d '8 days ago' /srv/confera/backups/pre-deploy-20260101T000000Z-000000000000.dump \
  /srv/confera/backups/nightly-20260101T000000Z.dump
touch -d '2 days ago' /srv/confera/backups/nightly-20260102T000000Z.dump
: >"$LOG"
out=$(/usr/local/sbin/confera-backup 2>&1)
code=$?
nightly=(/srv/confera/backups/nightly-*Z.dump)
files=(/srv/confera/backups/files-*Z.tar)
if [ "$code" -eq 0 ] && [[ "$out" == *"backup ok"* ]] && [ "${#files[@]}" -eq 1 ] && [ -s "${files[0]}" ] &&
  [ "$(stat -c '%U %a' "${files[0]}")" = "root 600" ] && [ "$(stat -c '%U %a' "${nightly[-1]}")" = "root 600" ] &&
  grep -q ' exec --no-TTY postgres pg_dump --username postgres --dbname confera --format custom' "$LOG" &&
  grep -q ' exec --no-TTY postgres pg_restore --list' "$LOG" &&
  grep -q '^run --rm --network none --read-only --cap-drop ALL .*source=confera_files,target=/files,readonly --entrypoint tar ' "$LOG"; then
  ok "backup: a checked dump and a tar of the file volume (read-only, no network), both root 0600"
else
  not_ok "backup: exit $code: $out; $(ls -la /srv/confera/backups); $(cat "$LOG")"
fi
[ ! -e /srv/confera/backups/pre-deploy-20260101T000000Z-000000000000.dump ] &&
  [ ! -e /srv/confera/backups/nightly-20260101T000000Z.dump ] && [ -e /srv/confera/backups/nightly-20260102T000000Z.dump ] &&
  [[ "$out" == *"removing /srv/confera/backups/nightly-20260101T000000Z.dump"* ]] &&
  ok "backup: files older than 7 days are removed and named; younger ones stay" ||
  not_ok "prune: $out; $(ls -la /srv/confera/backups)"
count_before=$(find /srv/confera/backups -type f | wc -l)
touch -d '8 days ago' /srv/confera/backups/nightly-20260102T000000Z.dump
touch /etc/fake-docker/bad-dump
out=$(/usr/local/sbin/confera-backup 2>&1)
code=$?
rm -f /etc/fake-docker/bad-dump
[ "$code" -eq 1 ] && [ "$(find /srv/confera/backups -type f | wc -l)" -eq "$count_before" ] &&
  [ -e /srv/confera/backups/nightly-20260102T000000Z.dump ] &&
  ok "backup: an unreadable dump fails (exit 1), keeps no file and prunes nothing" ||
  not_ok "bad backup: exit $code: $out; $(ls -la /srv/confera/backups)"
exec 9>/run/lock/confera-deploy.lock
flock 9
: >"$LOG"
out=$(timeout 5 /usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
code=$?
exec 9>&-
[ "$code" -eq 75 ] && [ "$(calls)" -eq 0 ] && ok "a deploy does not start while the backup holds the lock" ||
  not_ok "lock shared with the backup: exit $code: $out"

chmod 0666 /etc/confera/deploy.conf
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
[ "$?" -eq 78 ] && ok "a configuration others may write is refused" || not_ok "unsafe conf: $out"
chmod 0644 /etc/confera/deploy.conf
cp /etc/confera/deploy.conf /tmp/deploy.conf
printf 'CONFERA_ROOT=$(id)\n' >>/etc/confera/deploy.conf
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
[ "$?" -eq 78 ] && ok "the configuration is read as data: a command in it is refused" || not_ok "conf injection: $out"
cp /tmp/deploy.conf /etc/confera/deploy.conf

exec 9>/run/lock/confera-deploy.lock
flock 9
out=$(/usr/local/sbin/confera-deploy be "$DIGEST" 2>&1)
[ "$?" -eq 75 ] && ok "one deploy at a time" || not_ok "lock: $out"
exec 9>&-

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
