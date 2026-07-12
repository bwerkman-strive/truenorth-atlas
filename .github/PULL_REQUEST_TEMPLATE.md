## What & why

<!-- One paragraph. Link the issue if one exists. -->

## Definition of done

- [ ] Server tests green: `cd server && npm test` (against the docker-compose scratch DB)
- [ ] Web tests green + production build passes: `cd web && npm test && npm run build`
- [ ] New behavior has tests (integration tests mock providers via `*_BASE_URL` overrides)
- [ ] No invariant from `AGENTS.md` weakened (single email path, daily-close canon,
      reorg reversibility, catalog procedure, stable unsub tokens, auth tiers)
- [ ] Schema changes are idempotent additions to `schema.sql`
- [ ] Docs updated if a serializer changed (`web/src/apiReference.js` — the contract test will fail otherwise)
- [ ] No secrets in code, fixtures, or logs
