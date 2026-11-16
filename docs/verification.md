# Verification record

## Duplicate JSON member rework

The focused QA cases use these raw request bodies and expected behavior:

- `{"ids":["a"],"IDS":["b"],"ids":["c"]}` returns HTTP 200 with one received/inserted ID; a subsequent listing contains only `c`.
- `{"ids":[1],"ids":["ok"]}` returns HTTP 400 with `{"error":"invalid JSON body"}`; a subsequent listing is empty.

The red run before the Worker change failed as expected: it stored `b` instead of `c`, and accepted the invalid earlier array element with HTTP 200. Its exit code is recorded as `1` in `../evidence/duplicate-json/red.log`. After the implementation change, the focused run passed both cases; `../evidence/duplicate-json/green.log` also includes the preexisting 1,000-ID test matched by the filter.

`decodeWriteIDs` still validates the complete JSON document and root object with `JSON.parse`, then consumes the shared ordered raw-member scanner (`readJSONFields`). It checks each case-insensitive `ids` member in input order, validates its array elements immediately, and retains the final valid member. The cursor decoder uses the same scanner. No dependency or migration-helper change was made.

## TypeScript Worker

Latest full suite ran through `npm run coverage` from `cf-id-ledger/`: both test files passed, 17 tests total. `npm run typecheck` passed. `npm run build` passed as a Wrangler dry run after the runtime change. Reproduce the focused QA run with these commands from `cf-id-ledger/`:

```sh
npm test -- test/api.test.ts -t duplicate --reporter=verbose
npm run coverage
npm run typecheck
npm run build
```

| Metric | Covered / total | Result |
| --- | ---: | ---: |
| Statements | 256 / 275 | 93.09% |
| Branches | 182 / 203 | 89.65% |
| Functions | 30 / 32 | 93.75% |
| Lines | 221 / 227 | 97.35% |

Coverage includes the executable Worker file `src/index.ts`; `src/env.d.ts` is type-only. The Gitea workflow enforces the existing 65% Istanbul thresholds.

Logs and retained reports: `../evidence/duplicate-json/coverage.log`, `../evidence/duplicate-json/typecheck.log`, `../evidence/duplicate-json/build-dry-run.log`, `../evidence/duplicate-json/lcov.info`, and `../evidence/duplicate-json/coverage-summary.json`. The red/green logs are alongside them.

Changed executable-line coverage is 13/13 (100%). The calculation intersects added/replaced lines in `git diff 3b60448` with current LCOV `DA` records. Covered `src/index.ts` lines: 144, 145, 147, 148, 149, 150, 152, 153, 154, 155, 156, 159, and 290. The result is `../evidence/duplicate-json/changed-line-coverage.json`.

The rollback test sends 999 unique IDs followed by `fail-last` as item 1,000. It verifies that a failed batch leaves only the preexisting row with its original timestamp, retry inserts 1,000 IDs, and a second retry inserts zero without changing that timestamp.

## Python runtime coverage (unchanged and reused from commit `3b60448`)

No Python source, tests, or migration logic changed in this focused rework; these results and artifacts are reused from commit `3b60448`, not rerun here. The isolated environment used Python 3.15.2 and Coverage.py 7.17.3. The exact reproducible commands from `cf-id-ledger/` are:

```sh
mkdir -p ../evidence
python3 -m venv ../evidence/coverage-venv
../evidence/coverage-venv/bin/python -m pip install coverage==7.17.3
../evidence/coverage-venv/bin/python -m coverage erase
../evidence/coverage-venv/bin/python -W error::ResourceWarning -m coverage run --branch --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -m unittest scripts.test_migrate -v
../evidence/coverage-venv/bin/python -W error::ResourceWarning -m coverage run --append --branch --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -m unittest discover -s skills/id-ledger-query/scripts -p 'test_*.py' -v
../evidence/coverage-venv/bin/python -m coverage report --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' --fail-under=65
../evidence/coverage-venv/bin/python -m coverage json --include='scripts/migrate.py,skills/id-ledger-query/scripts/query_ids.py' -o ../evidence/python-coverage.json
```

The migration suite passed 8 tests; the query client suite passed 5. Both runtime files exceed 65% statements and branch arcs. Coverage.py's `Cover` column combines statement and branch coverage; `--fail-under=65` gates that report total.

| Runtime file | Statements | Branch arcs | Coverage.py `Cover` |
| --- | ---: | ---: | ---: |
| `scripts/migrate.py` | 63 / 64 (98.44%) | 13 / 14 (92.86%) | 97% |
| `skills/id-ledger-query/scripts/query_ids.py` | 68 / 81 (83.95%) | 19 / 26 (73.08%) | 81% |
| Total | 131 / 145 (90.34%) | 32 / 40 (80.00%) | 88% |

Reused text logs: `../evidence/python-coverage-migrate-tests.log`, `../evidence/python-coverage-query-tests.log`, `../evidence/python-coverage-report.log`, and `../evidence/python-coverage-json.log`. JSON details: `../evidence/python-coverage.json`.

## Local D1 export/import verification (unchanged and reused from commit `3b60448`)

The four-row synthetic fixture and exact migration verification are reused from commit `3b60448`; the standalone export/import round trip was not repeated in this focused rework. Real local D1 Worker tests did run in the current Vitest suite. The fixture covers case-sensitive project keys and IDs, quote, newline, Unicode, NUL, and original timestamps. The original commands were:

```sh
npx wrangler d1 migrations apply cf-id-ledger --local
python3 scripts/migrate.py export ../evidence/hh1926-source.sqlite ../evidence/hh1926-seed.sql
npx wrangler d1 execute cf-id-ledger --local --file ../evidence/hh1926-seed.sql
npx wrangler d1 export cf-id-ledger --local --output ../evidence/hh1926-d1-export.sql
```

After the D1 export, the SQL was restored using the NUL conversion block in `README.md`; then the unchanged verifier reported `Verified 4 exact rows, including project, ID and timestamp.` Log: `../evidence/local-d1-roundtrip-verify.log`. Wrangler 4.162.0 emitted a raw NUL in the SQL export; `../evidence/hh1926-d1-export-sqlite.sql` records the `'||char(0)||'` conversion. The local D1 fixture rows were cleared afterward; the migration remains applied.

## Limits

The Gitea workflow has not been run on a hosted runner. No Cloudflare resource, remote D1 operation, production import, or deployment was performed. The successful build in this rework was a dry run only.
