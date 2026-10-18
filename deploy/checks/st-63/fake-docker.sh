#!/bin/bash
# A stand-in for the docker command inside the ST-63 test container (deploy/checks/st-63).
# It records every call, one line each, and answers as the real one would for a deploy.
# /etc/fake-docker/label holds what `image inspect` prints for the jobs-image label.
printf '%s\n' "$*" >>/var/log/fake-docker.log
case "$1 ${2-}" in
  "image inspect") cat /etc/fake-docker/label ;;
  "compose "*)
    if [ -f /etc/fake-docker/fail-migrate ] && [[ " $* " == *" run "*" migrate "* ]]; then exit 1; fi
    ;;
esac
exit 0
