#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CARGO_TOML="$ROOT_DIR/backend/Cargo.toml"
DOCKER_ENV_FILE="$ROOT_DIR/.docker.env"

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

is_stable_version() {
  case "$1" in
    *-*) return 1 ;;
    *) return 0 ;;
  esac
}

release_channel_tags() {
  case "$1" in
    *-rc.*)
      printf '%s' 'rc pre'
      ;;
    *-beta.*)
      printf '%s' 'beta pre'
      ;;
    *)
      printf '%s' ''
      ;;
  esac
}

fail() {
  printf 'scripts/build.sh: %s\n' "$1" >&2
  exit 1
}

if [ -f "$DOCKER_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$DOCKER_ENV_FILE"
  set +a
fi

CARGO_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$CARGO_TOML" | head -n 1)"
[ -n "$CARGO_VERSION" ] || fail "impossible de lire la version depuis backend/Cargo.toml"

IMAGE_NAME="${IMAGE_NAME:-routecraft}"
APP_VERSION="${APP_VERSION:-$CARGO_VERSION}"
[ "$APP_VERSION" = "$CARGO_VERSION" ] || fail "APP_VERSION doit correspondre à backend/Cargo.toml ($CARGO_VERSION)"

BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-${CI_PIPELINE_IID:-${CI_BUILD_NUMBER:-}}}}"
GIT_SHA="${GIT_SHA:-$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown')}"
GIT_URL="${GIT_URL:-$(git config --get remote.origin.url 2>/dev/null || printf 'unknown')}"
BUILD_DATE="${BUILD_DATE:-$(git log -1 --format=%cI 2>/dev/null || printf 'unknown')}"
GIT_TAG="${GIT_TAG:-$(git describe --tags --exact-match 2>/dev/null || true)}"
GIT_DIRTY="${GIT_DIRTY:-$(if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then printf true; else printf false; fi)}"
RELEASE_BUILD="${RELEASE_BUILD:-false}"
BUILD_PUSH="${BUILD_PUSH:-false}"

if is_true "$RELEASE_BUILD"; then
  EXPECTED_TAG="v$APP_VERSION"
  [ -n "$GIT_TAG" ] || fail "release build demandé mais HEAD n'est pas tagué"
  [ "$GIT_TAG" = "$EXPECTED_TAG" ] || fail "tag Git $GIT_TAG différent de la version Cargo attendue $EXPECTED_TAG"
  [ "$GIT_DIRTY" = "false" ] || fail "release build refusé: le worktree est dirty"
fi

TAGS="-t $IMAGE_NAME:$APP_VERSION"
if [ -n "$BUILD_NUMBER" ]; then
  TAGS="$TAGS -t $IMAGE_NAME:${APP_VERSION}-build.$BUILD_NUMBER"
fi
if is_true "$RELEASE_BUILD"; then
  if is_stable_version "$APP_VERSION"; then
    TAGS="$TAGS -t $IMAGE_NAME:latest"
  else
    for channel_tag in $(release_channel_tags "$APP_VERSION"); do
      TAGS="$TAGS -t $IMAGE_NAME:$channel_tag"
    done
  fi
fi

printf 'Building %s\n' "$IMAGE_NAME"
printf '  release version : %s\n' "$APP_VERSION"
printf '  build number    : %s\n' "${BUILD_NUMBER:-<none>}"
printf '  git tag         : %s\n' "${GIT_TAG:-<none>}"
printf '  git sha         : %s\n' "$GIT_SHA"
printf '  dirty           : %s\n' "$GIT_DIRTY"
printf '  release build   : %s\n' "$RELEASE_BUILD"
printf '  push image      : %s\n' "$BUILD_PUSH"

set -- \
  --platform "${DOCKER_PLATFORM:-linux/amd64}" \
  --build-arg "APP_VERSION=$APP_VERSION" \
  --build-arg "BUILD_NUMBER=${BUILD_NUMBER:-unknown}" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  --build-arg "GIT_URL=$GIT_URL" \
  --build-arg "GIT_SHA=$GIT_SHA" \
  --build-arg "GIT_DIRTY=$GIT_DIRTY" \
  .

if is_true "$BUILD_PUSH"; then
  set -- --push "$@"
else
  set -- --output=type=docker "$@"
fi

# shellcheck disable=SC2086
docker buildx build $TAGS "$@"
