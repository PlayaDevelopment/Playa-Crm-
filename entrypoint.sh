#!/bin/sh
set -e
mkdir -p /app/data
if [ ! -f /app/data/playa.db ]; then
  if [ -f /app/seed/playa.db ]; then
    cp /app/seed/playa.db /app/data/playa.db
  elif [ -f /app/seed/playa.db.b64 ]; then
    base64 -d /app/seed/playa.db.b64 > /app/data/playa.db
  fi
fi
if [ ! -f /app/data/Playa_CRM.xlsx ]; then
  if [ -f /app/seed/Playa_CRM.xlsx ]; then
    cp /app/seed/Playa_CRM.xlsx /app/data/Playa_CRM.xlsx
  elif [ -f /app/seed/Playa_CRM.xlsx.b64 ]; then
    base64 -d /app/seed/Playa_CRM.xlsx.b64 > /app/data/Playa_CRM.xlsx
  fi
fi
exec node server.js
