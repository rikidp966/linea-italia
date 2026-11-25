#!/bin/sh
# Scarica i dati delle città mancanti e ripubblica il sito ogni 10 minuti finché il download non finisce.
cd "$(dirname "$0")/.."
"/c/Program Files/nodejs/node.exe" tools/scarica-osm.js >> tools/scarica.log 2>&1 &
PID=$!
prima=$(ls public/data | wc -l)
while kill -0 $PID 2>/dev/null; do
  sleep 600
  ora=$(ls public/data | wc -l)
  if [ "$ora" -gt "$prima" ]; then sh tools/pubblica.sh "Altre città con dati inclusi ($ora)" >> tools/scarica.log 2>&1; prima=$ora; fi
done
sh tools/pubblica.sh "Dati inclusi per le città in elenco" >> tools/scarica.log 2>&1
echo "PUBBLICAZIONE FINALE FATTA" >> tools/scarica.log
