#!/bin/bash
# Builds the two images of confera_be as OCI archives, with their digests (M4-BE-08; ADR-27).
#
#   deploy/ci/build-images.sh <output directory> <revision>
#
# Run by the build job of .github/workflows/image.yml, which holds no credential of any kind:
# it cannot push and it cannot deploy. The publish job then copies the archives to the registry
# unchanged (skopeo --preserve-digests), so the digest printed here is the digest a server pulls.
#
#   1. the jobs image (migrate, provision, seed) -> jobs.tar, its digest
#   2. the runtime image (API and worker), labelled with the jobs image BY DIGEST
#      (org.udekom.confera.jobs-image): a deploy names one digest, and the jobs image it migrates
#      with follows from the content of that image -> runtime.tar, its digest
#   3. both archives loaded into the local Docker as confera-m4-infra-{jobs,api}:check, so that the
#      checks of deploy/checks look at exactly what will be pushed
#
# Writes <output>/digests.env: CONFERA_BE_DIGEST and CONFERA_BE_JOBS_DIGEST.
# Needs a buildx builder that can export OCI archives (the workflow creates one; Docker Desktop
# with the containerd image store has one by default).
set -euo pipefail

out=${1:?usage: build-images.sh <output directory> <revision>}
revision=${2:?usage: build-images.sh <output directory> <revision>}
readonly REGISTRY=ghcr.io/stojanivanisevic
mkdir -p "$out"

digest_of() {
  # The image manifest named by the archive's index (one platform, no attestation).
  tar -xOf "$1" index.json | node -e '
    let text = ""; process.stdin.on("data", (c) => (text += c)).on("end", () => {
      const index = JSON.parse(text);
      if (index.manifests.length !== 1) { console.error("expected one manifest"); process.exit(1); }
      process.stdout.write(index.manifests[0].digest);
    });'
}

build() {
  local target=$1 archive=$2 name=$3
  shift 3
  docker buildx build --target "$target" --platform linux/amd64 \
    --provenance=false --sbom=false \
    --build-arg "CONFERA_REVISION=$revision" \
    --output "type=oci,dest=$archive,name=$name" "$@" .
}

build jobs "$out/jobs.tar" confera-m4-infra-jobs:check
jobs_digest=$(digest_of "$out/jobs.tar")
[[ "$jobs_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "no digest for the jobs image" >&2; exit 1; }

label="org.udekom.confera.jobs-image=$REGISTRY/confera-be-jobs@$jobs_digest"
build runtime "$out/runtime.tar" confera-m4-infra-api:check --label "$label"
runtime_digest=$(digest_of "$out/runtime.tar")
[[ "$runtime_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "no digest for the runtime image" >&2; exit 1; }

docker load --input "$out/jobs.tar"
docker load --input "$out/runtime.tar"

printf 'CONFERA_BE_DIGEST=%s\nCONFERA_BE_JOBS_DIGEST=%s\n' "$runtime_digest" "$jobs_digest" >"$out/digests.env"
cat "$out/digests.env"
