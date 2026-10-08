#!/usr/bin/env bash
# Builds superagent's images and tags them for a release (decision D42). With --save, also writes them
# to release/superagent-<version>.tar.gz (and its .sha256) to copy to the server and `docker load`
# there: the server runs images, it never builds them.
#
#   scripts/release.sh [version] [--save]    version: apps/api's package version by default
#
# The API, runner and egress images get the version's tag (SUPERAGENT_VERSION in the server's .env).
# The sandbox, browser and MCP images keep the tags the runner's configuration names. Third-party
# images (Postgres, SeaweedFS, SearXNG, Crawl4AI, rclone) are pulled on the server by compose.
set -euo pipefail
cd "$(dirname "$0")/.."

version=""
save=no
for arg in "$@"; do
  case "$arg" in
    --save) save=yes ;;
    *) version=$arg ;;
  esac
done
version=${version:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' apps/api/package.json | head -n 1)}
if ! [[ "$version" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Not a valid image tag: '$version'" >&2
  exit 1
fi
# A release is a commit: the server checks it out next to its images.
commit=$(git rev-parse HEAD)
if [ "$save" = yes ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes: commit them first, so the release matches its commit" >&2
  exit 1
fi

docker compose --profile app build
for name in api runner egress; do
  docker tag "superagent-$name:local" "superagent-$name:$version"
done
images=(
  "superagent-api:$version"
  "superagent-runner:$version"
  "superagent-egress:$version"
  superagent-sandbox-dev:1
  superagent-browser:1
  superagent-mcp:1
)
echo "Tagged: ${images[*]}"

if [ "$save" = yes ]; then
  mkdir -p release
  file="superagent-$version.tar.gz"
  docker save "${images[@]}" | gzip -6 >"release/$file"
  echo "$commit" >"release/superagent-$version.commit"
  (cd release && sha256sum "$file" "superagent-$version.commit" >"$file.sha256")
  echo "Saved release/$file ($(du -h "release/$file" | cut -f1)), its commit and their sha256"
  echo "On the server: git checkout $commit"
fi
