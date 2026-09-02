---
name: armada-api
description: Repair the hand-written Armada wire types when the API contract check fails, or extend them to cover a new endpoint. Use when `bun run check:armada-api` reports mismatches, when bumping `.armada-version`, or when adding a call to Armada's REST API.
---

# Armada API surface

This adapter talks to Armada's grpc-gateway REST API with types written by hand in
`src/armada-types.ts`, not generated. Read the header of that file for why.

The safety net is `bun run check:armada-api` (`scripts/check-armada-api.ts`). It fetches
`pkg/api/api.swagger.json` at the release named in `.armada-version` and asserts that
every field the `CONTRACT` table names still exists with the type we read it as. CI runs
the same check, in the `armada-api` job, whenever one of those files changed.

## When the check fails

The failure names the definition and field, for example
`apiJobRunningEvent.podName is gone`. For each one:

1. Fetch the spec it points at and look at the definition:
   `curl -s <url> | jq '.definitions.apiJobRunningEvent'`.
2. Work out what happened: renamed, retyped, removed, or moved into a nested object.
3. Fix `src/armada-types.ts` and the `CONTRACT` table in the script **together**. They are
   two halves of one statement. A fix that only edits the table makes the check pass while
   the code stays wrong.
4. Fix the call sites in `src/armada.ts`.
5. Re-run `bun run check:armada-api`, then `bun run typecheck`.

A field disappearing from an event we consume is not a formality: `waitForRunning` and
`ingressAddress` are built on `apiJobRunningEvent` and `apiJobIngressInfoEvent`, so a
change there means jobs never resolve rather than a compile error.

## When adding an endpoint

1. Find its definitions in the spec (`jq '.paths' `, then follow the `$ref`s).
2. Add the types to `src/armada-types.ts`. Keep received fields optional: this is proto3
   JSON, so the server omits anything at its default value. Fields we always send may be
   required.
3. Do not re-declare Kubernetes types. `podSpec` and friends come from
   `@kubernetes/client-node` as type-only imports.
4. Add the endpoint to `ENDPOINTS` and every field you read to `CONTRACT`.
5. Run `bun run check:armada-api`. It validates what you just wrote against the real spec,
   so it catches a wrong guess immediately.

## When bumping Armada

Edit `.armada-version`, run the check, and deal with whatever it reports. The pinned
version is also what `dev/` targets, so keep the local cluster on the same release.
Check a candidate version without editing the file:

```bash
ARMADA_VERSION=v0.23.0 bun run check:armada-api
```
