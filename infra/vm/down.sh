#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=infra/vm/common.sh
source "$(dirname "$0")/common.sh"
parse_dry_run "$@"
if ! "$DRY_RUN"; then require_owned_vm; fi
run gcloud compute instances stop "$MA_VM" --project="$MA_PROJECT" --zone="$MA_ZONE"
