#!/usr/bin/env bash
# Push every fixture to its own public GitHub repo (shipyard-fixture-<name>) for the e2e test.
# fixtures/ stays the source of truth: each push replaces the repo's history with one commit.
# Needs `gh auth login` first. Re-run whenever a fixture changes.
set -euo pipefail
cd "$(dirname "$0")"
OWNER="${FIXTURES_OWNER:-isthatsahil}"
for dir in */; do
  name=$(basename "$dir"); repo="$OWNER/shipyard-fixture-$name"
  gh repo view "$repo" >/dev/null 2>&1 || gh repo create "$repo" --public --description "Shipyard e2e fixture: $name"
  # Skip local installs; each fixture's .gitignore already keeps build output out of the commit.
  tmp=$(mktemp -d); rsync -a --exclude node_modules "$dir" "$tmp/"
  (cd "$tmp" && git init -q -b main && git add -A && git commit -qm "fixture: $name" && git push -qf "https://github.com/$repo.git" main)
  rm -rf "$tmp"
  echo "published $repo"
done
