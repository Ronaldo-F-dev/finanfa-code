#!/usr/bin/env bash
# Sets the container up like the CI "test" job (.github/workflows/ci.yml), so the
# suites that exercise real external tools run here instead of being skipped.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap tesseract-ocr poppler-utils avrdude socat tmux ffmpeg git

# Real-git-repo tests commit; give them an identity if the host didn't pass one in.
git config --global user.email >/dev/null 2>&1 || git config --global user.email "dev@example.com"
git config --global user.name >/dev/null 2>&1 || git config --global user.name "Dev"

npm ci
# Chromium for the browser-driven tests (--with-deps pulls its system libraries).
npx playwright-core install --with-deps chromium
