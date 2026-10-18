#!/bin/sh
# Entry of the Confera images (runtime and jobs). M4-BE-07; ADR-26: secrets per service, as files.
#
# Docker Compose mounts the secret files a service is given under /run/secrets/<name>
# (deploy/compose.yml, `secrets:`). This script turns each of them into the one variable the
# application reads, then replaces itself with the command (`exec`), so the application is
# process 1's only child and gets every signal.
#
# - Only the names below are accepted: a file with any other name stops the start (exit 78,
#   the code of a bad configuration), so a secret file can never set PATH, NODE_OPTIONS or a
#   variable the application does not know.
# - A value is never printed. A trailing newline of a file is dropped.
# - The secret is in the environment of the application process only: it is not in the
#   container's configuration (`docker inspect` shows no secret value).
set -eu

SECRETS_DIR=/run/secrets

# name of the file -> variable. One line each; the application's schema is in src/config.
variable_for() {
  case "$1" in
    database_url) echo DATABASE_URL ;;
    system_database_url) echo SYSTEM_DATABASE_URL ;;
    data_key) echo DATA_KEY ;;
    # The one-shot jobs only (deploy/compose.yml gives them to `migrate` and `provision`).
    migration_database_url) echo MIGRATION_DATABASE_URL ;;
    postgres_password) echo POSTGRES_PASSWORD ;;
    *) return 1 ;;
  esac
}

if [ -d "$SECRETS_DIR" ]; then
  for file in "$SECRETS_DIR"/*; do
    [ -e "$file" ] || continue
    name=$(basename "$file")
    if ! variable=$(variable_for "$name"); then
      echo "confera-entrypoint: /run/secrets/$name is not a secret this image knows; refusing to start" >&2
      exit 78
    fi
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "confera-entrypoint: /run/secrets/$name cannot be read by uid $(id -u); refusing to start" >&2
      exit 78
    fi
    value=$(cat "$file")
    export "$variable=$value"
  done
fi
unset file name variable value

exec "$@"
