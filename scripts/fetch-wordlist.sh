#!/usr/bin/env bash
# Downloads the official dictionary (172,820 words) from the game's upstream
# repo (clockworklabs/scrabblebot, MIT) at the commit the server runs, and
# checks it byte for byte.
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT="$(cat data/UPSTREAM_COMMIT)"
URL="https://raw.githubusercontent.com/clockworklabs/scrabblebot/${COMMIT}/spacetimedb/wordlist.txt"
SHA256=b819e7b67f8f2c80640ae76f0edbe59a4a1befb6de0f348463642ad49bdd2ad3
curl -fsSL "$URL" -o data/wordlist.txt.tmp
echo "${SHA256}  data/wordlist.txt.tmp" | sha256sum -c --quiet
mv data/wordlist.txt.tmp data/wordlist.txt
echo "data/wordlist.txt: $(wc -l < data/wordlist.txt) words"
