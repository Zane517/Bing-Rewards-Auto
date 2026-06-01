#!/bin/bash
echo "========================================"
echo "  Bing Rewards - Auto Search"
echo "========================================"
echo ""

if [ ! -d "node_modules" ]; then
  echo "[!] Dependencies not found. Running npm install..."
  npm install
fi

node index.js "$@"
