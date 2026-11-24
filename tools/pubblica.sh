#!/bin/sh
# Pubblica su GitHub Pages: commit su main, poi il contenuto di public/ sul ramo gh-pages.
# Uso: sh tools/pubblica.sh "messaggio"
set -e
cd "$(dirname "$0")/.."
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "${1:-Aggiornamento}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi
git push -q origin main
git subtree split --prefix public -b gh-pages -q
git push -q -f origin gh-pages
echo "Pubblicato: $(ls public/data/*.json 2>/dev/null | wc -l) città con dati inclusi"
