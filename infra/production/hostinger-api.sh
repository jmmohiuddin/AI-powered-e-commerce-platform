#!/usr/bin/env bash
# Thin wrapper for the Hostinger API. Only ever talks to developers.hostinger.com.
#
#   ./hostinger-api.sh GET  /api/vps/v1/virtual-machines
#   ./hostinger-api.sh POST /api/vps/v1/virtual-machines/123/start
#   ./hostinger-api.sh POST /api/vps/v1/firewall/1/rules payload.json
#
# The token lives in ~/.hostinger-token (chmod 600), never on the command line.
set -euo pipefail

METHOD=${1:?usage: hostinger-api.sh METHOD /api/path [json-payload-file]}
API_PATH=${2:?usage: hostinger-api.sh METHOD /api/path [json-payload-file]}
PAYLOAD_FILE=${3:-}

TOKEN=$(cat ~/.hostinger-token)

args=(-sS -X "$METHOD" "https://developers.hostinger.com${API_PATH}"
  -H "Authorization: Bearer ${TOKEN}")

if [[ -n "$PAYLOAD_FILE" ]]; then
  args+=(-H "Content-Type: application/json" --data @"$PAYLOAD_FILE")
fi

curl "${args[@]}"
echo
