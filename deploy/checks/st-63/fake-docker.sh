#!/bin/bash
# A stand-in for the docker command inside the ST-63 test container (deploy/checks/st-63).
# It records every call, one line each, and answers as the real one would for a deploy.
# /etc/fake-docker/label holds what `image inspect` prints for the jobs-image label.
# Switches (files in /etc/fake-docker): fail-migrate, slow-migrate, slow-dump, fail-dump, empty-dump, bad-dump (pg_dump
# writes something pg_restore cannot read), fail-up-once (the next `up` fails, the one after
# succeeds: a new version that does not become healthy, then the rollback), fail-up-always.
# /etc/fake-docker/image-migrations and applied-migrations: what the jobs image holds and what
# _prisma_migrations lists (no-migrations-table: the database has never been migrated).
printf '%s\n' "$*" >>/var/log/fake-docker.log
switch() { [ -f "/etc/fake-docker/$1" ]; }
case "$1 ${2-}" in
  "image inspect") cat /etc/fake-docker/label ;;
  "run "*)
    # The migration list of the jobs image (docker run ... --entrypoint ls <image> /app/prisma/migrations).
    if [[ " $* " == *" --entrypoint ls "*" /app/prisma/migrations "* ]]; then
      cat /etc/fake-docker/image-migrations
      echo migration_lock.toml
    fi
    # The tar of the file volume (confera-backup): a real, small tar.
    if [[ " $* " == *" --entrypoint tar "* ]]; then
      switch fail-tar && exit 1
      tar -C /etc/fake-docker -cf - label
    fi
    ;;
  "compose "*)
    args=" $* "
    if switch fail-migrate && [[ "$args" == *" run "*" migrate "* ]]; then exit 1; fi
    # slow-migrate: the migration takes 3 s and says when it started (a session drops meanwhile).
    if switch slow-migrate && [[ "$args" == *" run "*" migrate "* ]]; then
      touch /tmp/migrate-started
      sleep 3
      exit 0
    fi
    if [[ "$args" == *" exec --no-TTY postgres pg_dump "* ]]; then
      switch fail-dump && exit 1
      # slow-dump: writes half an archive, says so, and takes 3 s (the deploy is killed meanwhile).
      if switch slow-dump; then
        printf 'PGDMP half'
        touch /tmp/dump-started
        sleep 3
        exit 0
      fi
      switch empty-dump && exit 0
      if switch bad-dump; then printf 'not an archive'; exit 0; fi
      printf 'PGDMP\001\020\000\004\010\001\001fake custom-format archive'
      exit 0
    fi
    if [[ "$args" == *" exec --no-TTY postgres pg_restore --list "* ]]; then
      head -c 5 | grep -q '^PGDMP' || { echo 'pg_restore: error: input file does not appear to be a valid archive' >&2; exit 1; }
      printf ';\n; Archive created at 2026-10-18 03:15:00 UTC\n;     dbname: confera\n;     Format: CUSTOM\n;\n'
      exit 0
    fi
    if [[ "$args" == *" exec --no-TTY postgres psql "* ]]; then
      if [[ "$args" == *"to_regclass"* ]]; then
        switch no-migrations-table && echo f || echo t
      else
        cat /etc/fake-docker/applied-migrations
      fi
      exit 0
    fi
    if [[ "$args" == *" run "*"--entrypoint tar "* ]]; then
      printf 'fake tar of the file volume'
      exit 0
    fi
    if [[ "$args" == *" up "* ]] && switch fail-up-always; then exit 1; fi
    if [[ "$args" == *" up "* ]] && switch fail-up-once; then
      rm -f /etc/fake-docker/fail-up-once
      exit 1
    fi
    ;;
esac
exit 0
