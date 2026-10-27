import { toWire } from '../link/frames.js';
import { LINK_REFUSED, LinkError } from './errors.js';
/** Outcomes a desktop may choose. `cancelled` and `unavailable` are host-side. */
export const CLIENT_APPROVAL_OUTCOMES = ['allowed-once', 'rejected'];
/** A promise that never settles; parks one branch of a race. */
const NEVER = new Promise(() => { });
/**
 * Route interactions to the desktop and take the first answer.
 *
 * Transport-agnostic: the sender is attached once the link exists, and a link
 * that goes away is reported through {@link setConnected}.
 */
export class InteractionBroker {
    #send = () => false;
    #connected = false;
    #counter = 0;
    #approvals = new Map();
    #questions = new Map();
    /** Attach the link. Before this, requests are recorded but not announced. */
    setSender(send) {
        this.#send = send;
    }
    /** Whether a desktop could answer right now. */
    hasDesktop() {
        return this.#connected;
    }
    /**
     * Report the link's state.
     *
     * Going down settles every pending interaction — `unavailable` for approvals,
     * an empty batch for questions. Coming up re-announces whatever is still
     * pending, which after a down transition is nothing; the re-announce exists for
     * a reconnect that never observed the down edge.
     *
     * @param connected - whether the handshake is currently complete.
     */
    setConnected(connected) {
        const was = this.#connected;
        this.#connected = connected;
        if (connected) {
            if (!was)
                this.republish();
            return;
        }
        if (!was)
            return;
        for (const [id, entry] of [...this.#approvals]) {
            this.#approvals.delete(id);
            entry.settle('unavailable');
        }
        for (const [id, entry] of [...this.#questions]) {
            this.#questions.delete(id);
            entry.settle([]);
        }
    }
    /** Re-send every pending request, for a desktop that just connected. */
    republish() {
        for (const [id, entry] of this.#approvals) {
            this.#send({ v: 1, type: 'approval', id, request: toWire(entry.request) });
        }
        for (const [id, entry] of this.#questions) {
            this.#send({ v: 1, type: 'question', id, request: toWire(entry.request) });
        }
    }
    /**
     * Ask the desktop for an approval decision.
     * @param request - DSH's own payload, forwarded as-is.
     * @param signal - aborts when the requesting tool withdraws.
     */
    beginApproval(request, signal) {
        const id = `ap-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
        if (signal?.aborted === true) {
            return { id, outcome: Promise.resolve('cancelled'), abandon: () => { } };
        }
        let settle = () => { };
        const promise = new Promise((resolve) => {
            settle = resolve;
        });
        this.#approvals.set(id, { request, settle });
        this.#send({ v: 1, type: 'approval', id, request: toWire(request) });
        let onAbort;
        const cancelled = new Promise((resolve) => {
            onAbort = () => {
                this.#approvals.delete(id);
                settle('cancelled');
                resolve('cancelled');
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        const outcome = Promise.race([promise, cancelled]).finally(() => {
            if (onAbort !== undefined)
                signal?.removeEventListener('abort', onAbort);
            this.#approvals.delete(id);
        });
        return {
            id,
            outcome,
            abandon: (answer) => {
                this.#approvals.delete(id);
                settle(answer);
            },
        };
    }
    /**
     * Ask the desktop for answers to a question batch.
     * @param request - DSH's own payload, forwarded as-is.
     * @param ids - the question ids in the batch, for validating the reply.
     * @param signal - aborts when the asking tool withdraws.
     */
    beginQuestions(request, ids, signal) {
        const id = `qs-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`;
        if (signal?.aborted === true) {
            return { id, answers: Promise.resolve([]), abandon: () => { } };
        }
        let settle = () => { };
        const promise = new Promise((resolve) => {
            settle = resolve;
        });
        this.#questions.set(id, { request, ids, settle });
        this.#send({ v: 1, type: 'question', id, request: toWire(request) });
        let onAbort;
        const withdrawn = new Promise((resolve) => {
            onAbort = () => resolve([]);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        const answers = Promise.race([promise, withdrawn]).finally(() => {
            if (onAbort !== undefined)
                signal?.removeEventListener('abort', onAbort);
            this.#questions.delete(id);
        });
        return {
            id,
            answers,
            abandon: () => {
                this.#questions.delete(id);
                settle([]);
            },
        };
    }
    /**
     * Apply one answer frame.
     *
     * @param id - the request id the desktop was given.
     * @param frame - the answer, as parsed from the link.
     * @returns whether it settled something still pending.
     * @throws LinkError when a question reply does not name each question once.
     */
    answer(id, frame) {
        const approval = this.#approvals.get(id);
        if (approval !== undefined) {
            const outcome = frame.outcome;
            if (outcome !== 'allowed-once' && outcome !== 'rejected') {
                throw new LinkError(LINK_REFUSED, `approval "${id}" needs outcome allowed-once or rejected`);
            }
            this.#approvals.delete(id);
            approval.settle(outcome);
            return true;
        }
        const question = this.#questions.get(id);
        if (question !== undefined) {
            const answers = Array.isArray(frame.answers) ? frame.answers : [];
            assertAnswerBatch(question.ids, answers);
            this.#questions.delete(id);
            question.settle(answers);
            return true;
        }
        return false;
    }
    /** Release everything still pending, for plugin unload. */
    dispose() {
        for (const entry of this.#approvals.values())
            entry.settle('cancelled');
        this.#approvals.clear();
        for (const entry of this.#questions.values())
            entry.settle([]);
        this.#questions.clear();
    }
    /** The approvals still awaiting an answer. Diagnostics only. */
    get pendingApprovals() {
        return this.#approvals.size;
    }
    /** The question batches still awaiting an answer. Diagnostics only. */
    get pendingQuestions() {
        return this.#questions.size;
    }
}
/**
 * Check a reply against the questions that were actually asked.
 *
 * DSH rejects a whole batch that does not name every question exactly once, so
 * catching it here avoids discarding an answer the operator already committed to.
 *
 * @param ids - the question ids from the request.
 * @param answers - the desktop's batch.
 * @throws LinkError when the batch does not match.
 */
export function assertAnswerBatch(ids, answers) {
    const expected = new Set(ids);
    const seen = new Set();
    for (const answer of answers) {
        const id = typeof answer === 'object' && answer !== null
            ? answer['id']
            : undefined;
        if (typeof id !== 'string' || !expected.has(id)) {
            throw new LinkError(LINK_REFUSED, `answer names unknown question "${String(id)}"`);
        }
        if (seen.has(id)) {
            throw new LinkError(LINK_REFUSED, `answer names question "${id}" twice`);
        }
        seen.add(id);
    }
    for (const id of ids) {
        if (!seen.has(id))
            throw new LinkError(LINK_REFUSED, `answer omits question "${id}"`);
    }
}
/**
 * Pull the question ids out of a `user-questions/request` payload.
 *
 * Measured shapes, not guesses: the real request is flat and often carries no
 * call id at all. Both are accepted, and a batch with no questions is `null` —
 * there would be nothing to answer.
 *
 * @param request - the Cordis event payload.
 * @returns the ids, or `null` when the payload has no answerable batch.
 */
export function readQuestionIds(request) {
    const record = (typeof request === 'object' && request !== null ? request : {});
    const inner = (typeof record['request'] === 'object' && record['request'] !== null ? record['request'] : {});
    const raw = Array.isArray(record['questions'])
        ? record['questions']
        : Array.isArray(inner['questions'])
            ? inner['questions']
            : [];
    const ids = raw
        .map((entry) => typeof entry === 'object' && entry !== null
        ? entry['id']
        : undefined)
        .filter((id) => typeof id === 'string' && id !== '');
    return ids.length === 0 ? null : ids;
}
/**
 * Register both waterfall answerers.
 *
 * @param ctx - the plugin context; listeners leave with it.
 * @param broker - the interaction broker.
 */
export function registerAnswerers(ctx, broker) {
    // `approval/request` is a waterfall: return an outcome to claim, call `next()`
    // to delegate. Only `allowed-once` grants the action.
    ctx.on('approval/request', ((request, next) => {
        return (async () => {
            // With nothing connected there is nothing to ask, so stay a pure
            // pass-through and leave the existing channels exactly as they were.
            if (!broker.hasDesktop())
                return await next();
            const signal = request?.signal;
            const handle = broker.beginApproval(request, signal);
            const delegated = next().then((outcome) => {
                // The terminal behaviour is "nobody answered"; racing it verbatim
                // would resolve instantly and the desktop could never answer.
                if (outcome === 'unavailable')
                    return NEVER;
                return { from: 'delegated', outcome };
            });
            let winner;
            try {
                winner = await Promise.race([
                    handle.outcome.then((outcome) => ({ from: 'desktop', outcome })),
                    delegated,
                ]);
            }
            catch (error) {
                // A listener further down threw. Nothing will answer this now, so the
                // desktop must stop showing it.
                handle.abandon('unavailable');
                throw error;
            }
            if (winner.from === 'delegated')
                handle.abandon(winner.outcome);
            return winner.outcome;
        })();
    }), { prepend: true });
    // `user-questions/request` is the same shape, returning an answer batch.
    ctx.on('user-questions/request', ((request, next) => {
        return (async () => {
            if (!broker.hasDesktop())
                return await next();
            const ids = readQuestionIds(request);
            // A batch with no questions could never be answered, so delegate rather
            // than claim something this layer cannot complete.
            if (ids === null)
                return await next();
            const signal = request?.signal;
            const handle = broker.beginQuestions(request, ids, signal);
            const desktop = handle.answers.then((answers) => answers.length === 0 ? NEVER : { from: 'desktop', answer: { answers } });
            const delegated = next().then((answer) => {
                const answers = answer?.answers;
                if (!Array.isArray(answers) || answers.length === 0)
                    return NEVER;
                return { from: 'delegated', answer };
            });
            const winner = await Promise.race([desktop, delegated]).catch((error) => {
                handle.abandon();
                throw error;
            });
            if (winner.from === 'delegated')
                handle.abandon();
            return winner.answer;
        })();
    }), { prepend: true });
}
