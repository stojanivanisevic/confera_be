#!/bin/bash
# A stand-in for logger(1) inside the ST-63 test container, which has no journal: it appends
# "<tag>: <message>" to /var/log/fake-journal.log, so the scenarios can read what the deploy
# script sent to the journal.
tag=logger
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag | -t) tag=$2; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
printf '%s: %s\n' "$tag" "$*" >>/var/log/fake-journal.log
