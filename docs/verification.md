# Verification record

## TypeScript Worker

Commands run from `cf-id-ledger/`:

```sh
npm test
npm run coverage
npm run typecheck
```

`npm test` and `npm run coverage` each passed both test files and all 15 cases. `npm run typecheck` completed with no errors. Coverage includes the executable Worker file `src/index.ts`; `src/env.d.ts` is type-only.

| Metric | Covered / total | Result |
| --- | ---: | ---: |
| Statements | 252 / 272 | 92.64% |
| Branches | 183 / 205 | 89.26% |
| Functions | 30 / 32 | 93.75% |
| Lines | 217 / 223 | 97.30% |

Logs: `../evidence/test-final-rollback.log`, `../evidence/coverage-final-rollback.log`, and `../evidence/typecheck-final-rollback.log`.

The rollback test exercises a 1,000-statement D1 batch whose final statement fails. It verifies the preexisting row and timestamp are the only data left, a retry inserts all 1,000 IDs, and a second retry inserts zero while preserving the original timestamp.

## Python runtime coverage

Coverage.py is isolated from the system Python in `../evidence/coverage-venv`. The recorded run used Python 3.15.2 and Coverage.py 7.17.3. From `cf-id-ledger/`, the complete reproducible run is:

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

Text logs: `../evidence/python-coverage-migrate-tests.log`, `../evidence/python-coverage-query-tests.log`, `../evidence/python-coverage-report.log`, and `../evidence/python-coverage-json.log`. Machine-readable details are in `../evidence/python-coverage.json`.

## Local D1 export/import verification

A synthetic four-row SQLite source exercised case-sensitive project keys and IDs, quote, newline, Unicode, NUL, and original timestamps. The source snapshot was exported by the existing helper, imported into local Wrangler D1, exported back to SQL, restored into SQLite, and compared with the unchanged verifier. After the D1 export, the SQL was restored using the NUL conversion block in `README.md` before running the final verifier command below:

```sh
npx wrangler d1 migrations apply cf-id-ledger --local
python3 scripts/migrate.py export ../evidence/hh1926-source.sqlite ../evidence/hh1926-seed.sql
npx wrangler d1 execute cf-id-ledger --local --file ../evidence/hh1926-seed.sql
npx wrangler d1 export cf-id-ledger --local --output ../evidence/hh1926-d1-export.sql
python3 scripts/migrate.py verify ../evidence/hh1926-source.sqlite ../evidence/hh1926-restored.sqlite
```

Verification output: `Verified 4 exact rows, including project, ID and timestamp.` Log: `../evidence/local-d1-roundtrip-verify.log`. Wrangler 4.162.0 emitted a raw NUL in its SQL export; `../evidence/hh1926-d1-export-sqlite.sql` records the documented `'||char(0)||'` conversion used to restore that export. Afterward, the local D1 fixture rows were cleared; the migration remains applied.

## Limits

Wrangler build dry run passed earlier; this turn did not rerun it because Worker implementation was unchanged. The Gitea workflow was not run on a hosted runner. No Cloudflare resource, remote D1 operation, production import, or deployment was performed.