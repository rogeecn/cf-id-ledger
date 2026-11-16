# CF ID Ledger

A Cloudflare Worker and D1 migration of the Go ID Ledger API. The contract baseline is `rogeecn/id-ledger` at `a1af667a3b04cd40adc7a4256123de0238f788a2`.

## Runtime and API

- `GET /healthz` is public and returns `{"status":"ok"}`.
- `POST /v1/projects/{project_key}/ids` requires `Authorization: Bearer <token>` and a JSON body such as `{"ids":["a","b"]}`. IDs and project keys are case-sensitive. The server assigns the first-write UTC timestamp; retries do not change it.
- `GET /v1/projects/{project_key}/ids?since=<RFC3339>&until=<RFC3339>&limit=100` returns IDs in descending timestamp and binary ID order. `since` is inclusive, `until` is exclusive and optional, and `limit` is 1–1000. Follow `next_cursor` to read later pages; it keeps the original time bounds.

`ID_LEDGER_TOKEN` is required at runtime. Local secrets belong in ignored `.dev.vars`; production secrets are set with Wrangler. Do not put real tokens in `wrangler.jsonc`, `.dev.vars.example`, CI, or source control.

## Development

Use Node.js 22 or newer. Install the pinned toolchain and prepare local bindings:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace the example value with a local-only token.
npx wrangler d1 migrations apply cf-id-ledger --local
npm run dev
```

The main `wrangler.jsonc` intentionally has a placeholder D1 UUID. The Vitest-only `wrangler.test.jsonc` uses an isolated local D1 binding and a non-production test token.

```sh
npm test
npm run coverage
npm run typecheck
npm run build
python3 -m unittest scripts.test_migrate -v
python3 -m unittest discover -s skills/id-ledger-query/scripts -p 'test_*.py' -v
```

`npm run build` runs `wrangler deploy --dry-run`; it does not deploy. Istanbul includes every executable file under `src/**/*.ts` and enforces at least 65% statements, branches, functions, and lines. Type-only declarations are not executable coverage inputs.

Python branch coverage runs both existing suites in an isolated environment and gates at 65%:

```sh
mkdir -p ../evidence
python3 -m venv ../evidence/coverage-venv
../evidence/coverage-venv/bin/python -m pip install coverage==7.17.3
../evidence/coverage-venv/bin/python -m coverage erase
../evidence/coverage-venv/bin/python -m coverage run --branch --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -m unittest scripts.test_migrate -v
../evidence/coverage-venv/bin/python -m coverage run --append --branch --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -m unittest discover -s skills/id-ledger-query/scripts -p 'test_*.py' -v
../evidence/coverage-venv/bin/python -m coverage report --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' --fail-under=65
../evidence/coverage-venv/bin/python -m coverage json --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -o ../evidence/python-coverage.json
```

See `docs/verification.md` for per-file coverage denominators, recorded metrics, and local D1 round-trip results.

## Production setup

These are operator steps; this repository has not created a Cloudflare account resource or deployed a Worker.

1. Create the D1 database with `npx wrangler d1 create cf-id-ledger` and replace the all-zero `database_id` in `wrangler.jsonc` with the returned UUID.
2. Apply the schema with `npx wrangler d1 migrations apply cf-id-ledger --remote`.
3. Set the production token with `npx wrangler secret put ID_LEDGER_TOKEN`.
4. Review `npm run build`, deploy with `npx wrangler deploy`, then attach the intended hostname or route in the Cloudflare account.
5. Verify `/healthz` and an authenticated API request before directing clients to the Worker.

Optional route declaration example for a future real hostname (documentation only; it is not configured in this repository):

```jsonc
{
  "routes": [{ "pattern": "ledger.example.com/*", "zone_name": "example.com" }]
}
```

## Moving existing SQLite data

Do the cutover with writes paused. DNS caches can keep clients reaching the old endpoint after a route change, so the old writer must remain paused through the cutover and rollback decision.

1. Stop or drain every old writer and take a consistent SQLite backup. Keep the original database and backup unchanged.
2. Create the D1 database, set its UUID, and apply migrations before importing data.
3. Export the paused SQLite snapshot to a **new** data-only SQL file:

   ```sh
   python3 scripts/migrate.py export /safe/id-ledger-before.sqlite /safe/id-ledger-data.sql
   ```

   The helper opens the source read-only, writes original timestamps and values, and refuses to overwrite an existing output. It uses hex literals for project keys and IDs, so quotes, newlines, Unicode, and NUL bytes are preserved. Do not use conflict-ignore behavior. The destination table must be empty. A failed partial import must only be retried after resetting a clean disposable target; do not blindly replay the file against production.

4. Import the data file:

   ```sh
   npx wrangler d1 execute cf-id-ledger --remote --file=/safe/id-ledger-data.sql
   ```

   Each row is one SQL statement. If a row exceeds D1's 100,000-byte SQL statement limit, the helper stops and removes its partial output. This helper has no alternate bound-parameter importer; stop and arrange a separately reviewed import path for that data.

5. Export D1 and compare every tuple, including timestamps, before switching clients:

   ```sh
   npx wrangler d1 export cf-id-ledger --remote --output=/safe/id-ledger-after.sql
   ```

   Restore the D1 export into an empty SQLite database before running `verify`. Wrangler 4.162.0 emits a raw NUL byte inside SQL string literals when a stored text value contains NUL; Python's `sqlite3.executescript()` rejects raw NUL in the SQL input. For such exports, convert each raw NUL byte to the SQL expression `'||char(0)||'` before restoring:

   ```sh
   python3 - <<'PY'
   from contextlib import closing
   import os
   from pathlib import Path
   import sqlite3

   source = Path("/safe/id-ledger-after.sql")
   target = Path("/safe/id-ledger-restored.sqlite")
   sql = source.read_bytes().replace(b"\x00", b"'||char(0)||'")
   descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
   os.close(descriptor)
   with closing(sqlite3.connect(target)) as db, db:
       db.executescript(sql.decode("utf-8"))
   PY
   python3 scripts/migrate.py verify /safe/id-ledger-before.sqlite /safe/id-ledger-restored.sqlite
   ```

   The `target` path must be new. The local round-trip test records this behavior and confirms all project, ID, and timestamp values survive.

6. Deploy the Worker and switch the intended hostname only after exact verification succeeds. At that same hostname, check `/healthz` and make an authenticated read against a known project and time range. Resume client writes to the new endpoint only after both that smoke read and the exact data comparison succeed. Keep the old writer paused through DNS cache expiry; stale requests must not write to the old database.

### Rollback

If cutover fails before the Worker accepts writes, route clients back to the old service, verify it, then resume the old writer. If the Worker has accepted any writes, pause both sides and reconcile those new IDs and timestamps into the old store before resuming it. A DNS rollback alone loses writes made only in D1. Keep the original backup and exported files until reconciliation is verified.

## Verification summary

Latest local run: TypeScript 17 tests passed; `src/index.ts` coverage was 93.09% statements (256/275), 89.65% branches (182/203), 93.75% functions (30/32), and 97.35% lines (221/227). The duplicate-member fix has 13/13 changed executable lines covered. Python 3.15 with coverage.py 7.17.3 ran 8 migration tests and 5 query-client tests; `scripts/migrate.py` measured 97% combined coverage (63/64 statements, 13/14 branches) and `skills/id-ledger-query/scripts/query_ids.py` measured 81% combined coverage (68/81 statements, 19/26 branches). See `docs/verification.md` and the task evidence logs for the changed-line coverage method, full commands, and local D1 four-row exact verification.

## Query client

The copied skill is in `skills/id-ledger-query/`. Set `ID_LEDGER_URL` and `ID_LEDGER_TOKEN` in the invoking environment, then run `python3 skills/id-ledger-query/scripts/query_ids.py ...`. The client sends `User-Agent: cf-id-ledger-query/1.0`, follows cursors, and does not print the token.
