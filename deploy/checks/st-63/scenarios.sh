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
#     an unsafe configuration, and leaves the running version alone on a failed migration.
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
if grep -Eq 'confera-web|--privileged|-v |--volume|/bin/sh|bash' "$LOG"; then
  not_ok "be: docker was asked for something else: $(cat "$LOG")"
else
  ok "be: docker was asked for nothing but pull, inspect and compose"
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
