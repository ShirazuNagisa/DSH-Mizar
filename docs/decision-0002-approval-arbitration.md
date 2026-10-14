# Decision 0002 — how the phone joins approval arbitration

Status: **accepted**, settled by reading Cordis's waterfall implementation and
verified by unit tests.

## Context

Two interactions make remote *guidance* possible: an agent that stops to ask
permission (`approval/request`) and an agent that stops to ask a question
(`user-questions/request`). Both are Cordis **waterfall** events on the host, and
both are already answered by other channels — the desktop GUI, through the
forwarded `$events` source, and the built-in terminal answerer.

The product requirement is that the phone is a **first-class** channel: the user
is away from the Mac but the Mac's DSH is still running *with its GUI open*. If
the phone only ever got the requests the GUI declined, it would never see one.

## What the waterfall actually does

From `@deepseek-ai/cordis` `src/events.ts`:

```js
waterfall(...args) {
  const cbs = this.dispatch('waterfall', args)  // registered listeners, in order
  const inner = args.pop()                       // the event's built-in behaviour
  const next = () => {
    const cb = cbs.shift() ?? inner
    return cb(...args)
  }
  args.push(next)
  return next()
}
```

Two consequences, neither obvious from the docs:

1. **Order is registration order**, which is mount order. This plugin mounts
   *after* the API layer, so a plain listener would run only when every earlier
   listener had already called `next()` — i.e. never, while the GUI is open.
2. **A terminal `next()` runs the built-in behaviour**, which for these events is
   "nobody is answering" — `unavailable` for an approval. It resolves
   *immediately*, not never.

## The decision

**Register with `prepend: true`, and race the phone against `next()` — but only
treat the delegated result as a claim when it is a real answer.**

```ts
ctx.on('approval/request', async (request, next) => {
  if (!broker.hasClients()) return await next()      // pure pass-through
  const handle = broker.beginApproval(readApprovalRequest(request), request.signal)
  const delegated = next().then((outcome) =>
    outcome === 'unavailable' ? NEVER : { from: 'delegated', outcome })
  const winner = await Promise.race([
    handle.outcome.then((outcome) => ({ from: 'phone', outcome })),
    delegated,
  ])
  if (winner.from === 'delegated') handle.abandon(winner.outcome)
  return winner.outcome
}, { prepend: true })
```

Each clause exists for a measured reason:

- **`prepend: true`** — otherwise the phone is a fallback, not a peer.
- **`hasClients()` short-circuit** — with no phone connected the plugin must not
  change existing behaviour at all. It stays a pure pass-through.
- **`outcome === 'unavailable' → NEVER`** — racing the terminal result verbatim
  would resolve instantly and the phone could never answer. `unavailable` means
  "the rest of the chain declined", not "the operator refused".
- **`abandon` on losing the race** — without it the phone keeps showing a card
  for a decision already taken elsewhere, and the broker's pending entry leaks
  for the life of the process. This was found by a test, not by reasoning.
- **Returning the *first real* answer** — this is DSH's own documented
  multi-client semantic: every channel is asked at once and the first answer wins.

## Failure mode: a phone that vanishes mid-question

An approval is one-shot and has **no late-answer path**; it is tied to an open
turn. If the phone disconnects while an approval is outstanding, the agent would
otherwise wait forever.

So the listener reports its authenticated client count to the broker, and
**dropping to zero settles every pending approval `unavailable`** and every
pending question empty. `unavailable` is the same outcome DSH uses when there is
no answerer, so the tool action fails closed.

This can preempt a desktop GUI that is still showing the card. That is the
deliberate trade: **a refused tool action is recoverable, a hung agent is not.**

Questions differ in one respect: they *do* have a late path. A batch the host
already timed out can still be answered, and the question's own projection
reports it as `continued`. So a dropped question is not lost.

## Consequences

- The plugin is a peer in every waterfall, so it never depends on being mounted
  early enough to win a race by ordering.
- `interactions.pending` exists because a client reconnecting after a dropped
  socket has no other way to discover a question asked while it was away —
  ordinary notifications are never replayed.
- Approval answers are validated against `'allowed-once' | 'rejected'` only.
  `cancelled` and `unavailable` are host-side outcomes, not client choices.
- Answer batches are checked against the questions *the broker asked* before
  being forwarded. DSH rejects a whole reply that does not name each question
  exactly once, so catching it locally avoids discarding an answer the operator
  already committed to.
