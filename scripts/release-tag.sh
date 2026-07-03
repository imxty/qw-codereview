#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
REMOTE="${REMOTE:-origin}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-Release ${TAG}}"

if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <tag>"
  echo "Example: $0 v2"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: this script must be run inside a git repository."
  exit 1
fi

echo "==> Building action bundle"
npm run build

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "==> Staging changed files"
  git add README.md action.yml package.json package-lock.json src/main.js src/utils.js dist/index.js scripts/release-tag.sh

  if ! git diff --cached --quiet; then
    echo "==> Creating release commit: ${COMMIT_MESSAGE}"
    git commit -m "$COMMIT_MESSAGE"
  else
    echo "==> No staged changes after build"
  fi
else
  echo "==> No local changes to commit"
fi

echo "==> Deleting remote tag if it exists: ${TAG}"
if git ls-remote --tags "$REMOTE" "refs/tags/${TAG}" | grep -q "refs/tags/${TAG}"; then
  git push "$REMOTE" ":refs/tags/${TAG}"
else
  echo "==> Remote tag ${TAG} does not exist, skipping remote delete"
fi

echo "==> Recreating local tag: ${TAG}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -d "$TAG"
fi
git tag "$TAG"

echo "==> Pushing current branch"
git push "$REMOTE" HEAD

echo "==> Pushing tag: ${TAG}"
git push "$REMOTE" "$TAG"

echo "==> Release complete: ${TAG}"
