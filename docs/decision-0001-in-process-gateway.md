# Decision 0001 — drive DSH's shipped Remotes in-process, not over the wire

Status: **accepted**, settled by measurement in Phase 0.1.

## Context

The whole design of `dsh-mizar` rests on one question: **from a third-party
Cordis plugin, how does the host half talk to DSH's own session, workspace,
model, permission and usage machinery?**

Three candidates were known up front:

1. **In-process strict gateway** — `ctx.typertGateway.invoke()` / `.stream()`
   against the generated descriptors DSH itself uses.
2. **Direct service calls** — `ctx.sessionController.*`,
   `ctx.sessionProjections.*`, `ctx.workspaceController.*`.
3. **Wire client** — be an ordinary HTTP/WS client of DSH's own `/api`, doing
   the launch-token → cookie exchange exactly as the Electron main process does.

Read-only inspection could not answer whether (1) was usable from a *foreign*
plugin: the gateway resolves descriptors relative to the calling context, and
the docs describe a `PeerScope`/`ctx.invocation` receiver that a plugin's own
context might not carry.

## What the spike did

`src/spike.ts`, enabled by `config.spike`, runs five probes once the required
strict endpoints are registered, and prints PASS/FAIL per probe. It was run
against a real `mizar-dev` profile (`@deepseek-ai/dsh-base` + `dsh-web-app` +
`dsh-mizar`) on 2026-10-14, DSH `0.2.0-rc.2`.

## Result — option 1 works

```
[mizar] readiness: all required endpoints registered — registered=126 missing=[]
PASS  typertGateway.invoke session/create      — sessionId=session-36d7bf3c-…
PASS  typertGateway.invoke session/list        — 1 session(s), agentAvailable=true
PASS  typertGateway.invoke session/modelCatalog— default={provider:deepseek-official, model:deepseek-flash} models=2
PASS  ctx.sessions.get + sessionProjections.snapshot
      — asOfSeq=2 present=[title,tokenUsage,contextPressure,contextBreakdown,sessionStats,permissions,modelSelection] missing=[]
PASS  ctx.sessionProjections.onChanged         — subscribed and disposed
PASS  typertGateway.stream session/control     — first frame={type:baseline,…}
```

**Decision: use option 1 (in-process strict gateway) as the primary path.**
Option 2 remains the fallback for any single endpoint the gateway refuses; the
whole point of the spike is that we no longer need to guess which.

Why not option 3: it would make Mizar a second authenticated browser client,
inheriting a host-and-port-bound 30-day cookie, no logout, no per-device
revocation, and the need to expose DSH's own webserver. Option 1 avoids all of
that and lets Mizar own its own listener and its own device model.

## Two operational constraints this established

These are not obvious from the docs, and both cost a failed run to find:

1. **`apply()` runs during composition; strict descriptors register later.**
   An immediate `invoke()` fails with `gateway/invocation-unavailable`
   ("no active Remote method exports this endpoint"). The failure is
   *ordering*, not a missing capability. Every gateway consumer must gate on
   descriptor availability — see `awaitEndpoints()` in `src/ready.ts`.
   In the measured run the registry settled at **126 descriptors**.

2. **Reading `ctx.typert` requires declaring `typert` in the plugin's `inject`.**
   Cordis refuses an undeclared service access with
   `cannot get property "typert" without inject`. The host half therefore injects
   `['typert', 'typertGateway', 'sessionProjections', 'sessions']`.

## Consequences for the design

- The Bridge layer calls `ctx.typertGateway.invoke/stream` with the **exact wire
  argument names** from the generated descriptors — e.g. `session/list` takes
  `_request` (leading underscore), while `session/prompt` takes `request`.
  Getting this wrong is a runtime error, not a compile error, so Phase 2 will
  derive the arg names from the same manifests rather than by hand.
- `ctx.sessionProjections.snapshot()` is **synchronous** and returns
  `{ asOfSeq, values }`. All four usage projections required by the mobile app
  are present on a freshly created, never-prompted session, with
  `tokenUsage` already carrying `{uncachedInputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens}` — the exact four fields the cache-hit-rate
  formula needs.
- A projection key that is **absent** means the owning package is not composed,
  and must render as "no capability", never as zero.
- Mizar does not need the unshipped `dsh-typert-generator`: it *consumes*
  existing descriptors rather than registering new Remotes.

## Reproducing

```sh
scripts/dev.sh bootstrap   # create .devhome + mizar-dev profile from the web template
scripts/dev.sh install     # build dsh-mizar and install it into the profile
scripts/dev.sh boot        # boot the profile and stream the log
```

`config.spike: true` in `.devhome/profiles/mizar-dev/cordis.patch.yml` is what
enables the probe set; remove it to boot quietly.
