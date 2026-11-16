# Verification record

## Duplicate JSON member rework

The focused QA cases use these raw request bodies and expected behavior:

- `{"ids":["a"],"IDS":["b"],"ids":["c"]}` returns HTTP 200 with one received/inserted ID; a subsequent listing contains only `c`.
- `{"ids":[1],"ids":["ok"]}` returns HTTP 400 with `{"error":"invalid JSON body"}`; a subsequent listing is empty.

The red run before the Worker change failed as expected: it stored `b` instead of `c`, and accepted the invalid earlier array element with HTTP 200. Its exit code is recorded as `1` in `../evidence/duplicate-json/red.log`. After the implementation change, the focused run passed both cases; `../evidence/duplicate-json/green.log` also includes the preexisting 1,000-ID test matched by the filter.

`decodeWriteIDs` still validates the complete JSON document and root object with `JSON.parse`, then consumes the shared ordered raw-member scanner (`readJSONFields`). It checks each case-insensitive `ids` member in input order, validates its array elements immediately, and retains the final valid member. The cursor decoder uses the same scanner. No dependency or migration-helper change was made.

## TypeScript Worker

The previous duplicate-member rework full suite ran through `npm run coverage` from `cf-id-ledger/`: both test files passed, 17 tests total. `npm run typecheck` passed. `npm run build` passed as a Wrangler dry run after that runtime change. Reproduce the focused QA run with these commands from `cf-id-ledger/`:

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

## Duplicate JSON null slice reuse

Two raw request bodies now verify Go's slice backing-array behavior across duplicate `ids` members:

- `{"ids":["a"],"ids":[null]}` returns HTTP 200 with `{"received":1,"inserted":1}`; listing the project returns only `a`.
- `{"ids":["a","b"],"ids":[null,"c"]}` returns HTTP 200 with `{"received":2,"inserted":2}`; listing returns `c`, then `a` in descending binary ID order.

A shrink-and-expand case, `{"ids":["a","b"],"ids":["c"],"ids":[null,null]}`, returns `c`, then `b`, retaining the slot beyond the shorter middle array. Reset cases `{"ids":["a"],"ids":[],"ids":[null]}`, `{"ids":["a"],"ids":null,"ids":[null]}`, and `{"ids":[""],"ids":[null]}` each return HTTP 400 with `{"error":"ids cannot contain empty strings"}` and leave the project empty.

Before the implementation change, `npm test -- test/api.test.ts -t 'duplicate ids member' --reporter=verbose` exited 1: the three value-reuse cases failed with HTTP 400, while the reset and earlier duplicate validation cases passed. After the change, the same command passed 5 tests with 15 skipped. The one full `npm run coverage` run passed both files and all 21 tests. Latest `src/index.ts` coverage:

| Metric | Covered / total | Result |
| --- | ---: | ---: |
| Statements | 261 / 280 | 93.21% |
| Branches | 186 / 207 | 89.85% |
| Functions | 30 / 32 | 93.75% |
| Lines | 225 / 231 | 97.4% |

`npm run typecheck` passed. `npm run build` passed as a Wrangler dry run (14.44 KiB upload, 4.34 KiB gzip). Changed executable-line coverage relative to `12ac8f2540647c7ed1d4ee5ba3f184a47fd5b3d7` is 6/6 (100%). Added/replaced diff lines were intersected with the current LCOV `DA` records: lines 145, 151, 155, 157, 158, and 160 are all covered. The calculation and output are included as `check_changed_lines.py` and `changed-line-coverage.json` in the evidence attachment.

Logs and reports: `../evidence/null-reuse/red.log`, `green.log`, `coverage.log`, `lcov.info`, `coverage-summary.json`, `typecheck.log`, and `build-dry-run.log`.

The original Go/Fiber/SQLite endpoint at `a1af667a3b04cd40adc7a4256123de0238f788a2` and the updated Worker through local Wrangler HTTP/D1 both replayed QA's unchanged 15 raw requests. All 15 match in HTTP status, exact response body, and ordered stored IDs. Only the probe's representation of zero database rows is normalized from Go `null` to `[]`; API responses are not normalized.

| QA case | HTTP status on both | Stored IDs on both |
| --- | ---: | --- |
| duplicate-case-order | 200 | `c` |
| invalid-first-valid-overwrite | 400 | none |
| invalid-first-null-overwrite | 400 | none |
| valid-first-invalid-overwrite | 400 | none |
| null-first-valid-overwrite | 200 | `ok-after-null` |
| valid-first-null-overwrite | 400 | none |
| slice-reuse-single-null | 200 | `a` |
| slice-reuse-null-prefix | 200 | `a`, `c` |
| mixed-case-repeats | 200 | `c` |
| escaped-ids-key | 200 | `escaped-key` |
| unknown-before | 400 | none |
| unknown-after | 400 | none |
| malformed-json | 400 | none |
| trailing-json | 400 | none |
| string-delimiters | 200 | exact original string preserved |

The evidence attachment includes the raw matrix, Go and Worker probe scripts, `original-json-matrix.log`, `worker-json-matrix-run.log`, `check_matrix.py`, and the complete per-case `matrix-comparison.json`. Run the included `bash qa-recheck-evidence/run-go-matrix-probe.sh`, `python3 qa-recheck-evidence/worker_json_matrix_probe.py`, then `python3 check_matrix.py` in the prepared evidence directory. The probe scripts require sibling `id-ledger` and `cf-id-ledger` checkouts and a fresh local D1 state directory. The Worker probe confirmed its Wrangler process exited and its local port closed.

Python coverage and the standalone local D1 migration roundtrip are reused from commit `3b60448`; neither was rerun for this change.

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
