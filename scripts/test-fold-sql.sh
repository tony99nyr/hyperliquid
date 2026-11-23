#!/usr/bin/env bash
# Run the position-fold SQL contract test (migrations 0052 and 0053) in a throwaway
# Postgres 16 container. Needs Docker. Not part of `pnpm validate`.
set -euo pipefail
cd "$(dirname "$0")/.."
name="hl-fold-sql-$$"
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=test postgres:16 >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT
for _ in $(seq 1 30); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 1
run() { docker exec -i "$name" psql -q -X -v ON_ERROR_STOP=1 -U postgres -t "$@"; }
run < scripts/sql-tests/position-fold-schema.sql
run < supabase/migrations/0052_position_fold_version.sql
run < supabase/migrations/0053_fold_gap_and_reopen_metadata.sql
run < scripts/sql-tests/position-fold.sql
