#!/bin/sh
set -e
mkdir -p /app/data
chmod 777 /app/data 2>/dev/null || true
if [ ! -f /app/data/playa.db ] && [ -f /app/seed/playa.db ]; then
  cp /app/seed/playa.db /app/data/playa.db
fi
if [ ! -f /app/data/Playa_CRM.xlsx ] && [ -f /app/seed/Playa_CRM.xlsx ]; then
  cp /app/seed/Playa_CRM.xlsx /app/data/Playa_CRM.xlsx
fi
exec node server.js
