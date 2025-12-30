#!/bin/bash
# Wrapper script to run Huly MCP server with decrypted secrets via sops

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="$SCRIPT_DIR/secrets/secrets.env"

exec ~/bin/sops exec-env "$SECRETS_FILE" "node $SCRIPT_DIR/src/index.mjs"
