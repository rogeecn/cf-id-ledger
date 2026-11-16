# Repository notes

This repository migrates ID Ledger from Go/Fiber to a TypeScript Cloudflare Worker with D1. The source contract is `rogeecn/id-ledger` at `a1af667a3b04cd40adc7a4256123de0238f788a2`.

- Keep the D1 schema in `migrations/0001_initial.sql` byte-for-byte aligned with the source schema unless the owner approves a schema change.
- Keep the Worker small and dependency-free. Test HTTP behavior against the local Workers runtime and real D1 bindings.
- Preserve the SQLite migration helper's data-only SQL and exact tuple verification behavior. Its importer requires an empty table and does not ignore conflicts.
- Keep `.dev.vars`, `.wrangler/`, generated coverage, and real credentials out of source control. Production account `3fa0cfdb08592ca45fb5677a46c9c0ff` already has Worker `cf-id-ledger`, D1 `cf-id-ledger` (`072d57c0-3ac7-42bb-8221-4dcc33de77f3`), and active zone `ipao.vip`; tests use `wrangler.test.jsonc` only.
- Before a production rollout, run `npx wrangler d1 migrations list cf-id-ledger --remote`. As of 2026-11-16 there were no pending migrations; routine redeploys do not need `d1 create`, `d1 migrations apply`, or legacy SQLite import.
- `ID_LEDGER_TOKEN` is the runtime API Bearer secret, distinct from Wrangler's Cloudflare OAuth credentials. Keep both out of source/config; provide the runtime value with a protected temporary JSON `--secrets-file` during deployment, as documented in `README.md`.
- The production hostname is the exact Custom Domain `id-ledger.ipao.vip` in `ipao.vip`; Wrangler's non-interactive deploy replaces the conflicting record for that hostname. Do not manually delete it or change unrelated DNS.
- Do not add production deployment, remote D1 migration, domain routing, or secret creation to CI.

Use Node.js 22+ and run `npm ci`, `npm test`, `npm run coverage`, `npm run typecheck`, and `npm run build`. Python checks are `python3 -m unittest scripts.test_migrate -v` and `python3 -m unittest discover -s skills/id-ledger-query/scripts -p 'test_*.py' -v`. The build command is a Wrangler dry run. Production migration and rollback steps are in `README.md`.
