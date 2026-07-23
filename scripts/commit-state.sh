#!/usr/bin/env bash
#
# Commit this run's changed state/ records to the default branch (main).
#
# Robust to two failure modes the workflows previously had:
#   1. Detached HEAD — release.yml runs on a pushed tag, so a bare `git push` had no
#      upstream and never recorded the release. We commit onto a fresh worktree of
#      origin/main instead, regardless of what ref the job is on.
#   2. Concurrent writers — release/reconcile/maintenance all write state/. We copy ONLY
#      the records this run changed (never mirroring/deleting) onto the LATEST origin/main
#      on every attempt, so two simultaneous runs can't lose each other's writes via a
#      non-fast-forward rejection — and there is no rebase to conflict on the same record.
#
# Usage: bash scripts/commit-state.sh "commit message"
set -euo pipefail

msg="${1:-chore(state): update}"

git config user.name "halyard-bot"
git config user.email "halyard-bot@users.noreply.github.com"

# The files THIS run created/modified under state/, relative to the job's checkout.
# NUL-delimited + --no-renames so paths with spaces/odd chars survive intact; strip the
# 3-char "XY " status prefix from each porcelain entry.
changed=()
while IFS= read -r -d '' entry; do
  changed+=("${entry:3}")
done < <(git status --porcelain -z --no-renames -- state/)

if [ "${#changed[@]}" -eq 0 ]; then
  echo "no state change"
  exit 0
fi

src="$(pwd)"
wt="$(mktemp -d)"
git worktree add --quiet --detach "$wt" HEAD
cd "$wt"

# Each attempt: snap to the freshest origin/main, lay our changed records on top, commit,
# push. A rejected push means someone else pushed in the meantime — loop and re-snap.
for attempt in 1 2 3 4 5; do
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  git clean --quiet -fd state/ 2>/dev/null || true

  for f in "${changed[@]}"; do
    mkdir -p "$(dirname "$f")"
    cp "$src/$f" "$f"
  done

  git add -- "${changed[@]}"
  if git diff --cached --quiet; then
    echo "no net change vs main"
    exit 0
  fi

  git commit --quiet -m "$msg"
  if git push --quiet origin HEAD:main; then
    echo "state committed to main"
    exit 0
  fi
  echo "push attempt $attempt rejected; re-snapping origin/main and retrying" >&2
  # (the next iteration's `git reset --hard origin/main` discards this attempt's commit)
  sleep $(((RANDOM % 5) + 2))
done

echo "::error::failed to push state to main after retries" >&2
exit 1
