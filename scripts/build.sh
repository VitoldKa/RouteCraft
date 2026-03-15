#!/usr/bin/env sh
set -eu

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Repo has uncommitted changes. Commit or stash before building." >&2
  exit 1
fi

if ! git describe --tags --exact-match >/dev/null 2>&1; then
  echo "Current commit is not tagged. Refusing to build." >&2
  exit 1
fi

IMAGE_NAME="${IMAGE_NAME:-RouteCraft}"

GIT_SHA="$(git rev-parse --short=12 HEAD)"
GIT_URL="$(git config --get remote.origin.url || echo unknown)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
APP_VERSION="$(git describe --tags --always)-$(git rev-parse --short HEAD)"

echo "Building $IMAGE_NAME:$APP_VERSION"

docker buildx build \
  --platform linux/amd64 \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg GIT_SHA="$GIT_SHA" \
  --build-arg BUILD_DATE="$BUILD_DATE" \
  --build-arg GIT_URL="$GIT_URL" \
  -t "$IMAGE_NAME:$APP_VERSION" \
  -t "$IMAGE_NAME:latest" \
  --output=type=docker .