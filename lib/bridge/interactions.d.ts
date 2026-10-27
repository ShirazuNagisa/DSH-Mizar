/**
 * Approvals and questions: the two interactions that make remote guidance real.
 *
 * Both are Cordis **waterfall** events, and both are already answered by other
 * channels — the desktop GUI and the built-in terminal answerer. The rules below
 * are the ones `decision-0002` measured; each exists because the obvious version
 * was wrong.
 *
 * 1. **`prepend: true`.** Registration order is mount order, and this plugin
 *    mounts after the API layer. A plain listener would only run once every
 *    earlier listener had called `next()` — i.e. never, while the GUI is open.
 * 2. **`hasDesktop()` short-circuit.** With nothing connected, this plugin must
 *    change nothing at all: pure pass-through.
 * 3. **`unavailable` is not an answer.** The waterfall's terminal behaviour is
 *    "nobody answered", and it resolves immediately. Racing it verbatim would
 *    mean the desktop could never answer.
 * 4. **Losing the race abandons the request.** Otherwise the desktop keeps
 *    showing a card for a decision already taken, and the entry leaks for the
 *    life of the process.
 * 5. **Dropping to zero settles everything.** An approval is one-shot and tied to
 *    an open turn; a desktop that vanished must not leave an agent waiting. A
 *    refused tool action is recoverable, a hung agent is not.
 *
 * The 0.9.0 difference is only in transport: requests go out as raw DSH payloads
 * over the link instead of being narrowed into Mizar views. Nothing here
 * interprets what an approval is about.
 *
 * @module dsh-mizar/bridge/interactions
 */
import type { Context } from '../dsh.js';
import { type FrameToDesktop } from '../link/frames.js';
/** Outcomes a desktop may choose. `cancelled` and `unavailable` are host-side. */
export declare const CLIENT_APPROVAL_OUTCOMES: readonly ["allowed-once", "rejected"];
/** One desktop-chosen approval outcome. */
export type ClientApprovalOutcome = (typeof CLIENT_APPROVAL_OUTCOMES)[number];
/** The full outcome vocabulary DSH accepts. */
export type ApprovalOutcome = ClientApprovalOutcome | 'cancelled' | 'unavailable';
/** A handle on one outstanding approval. */
export interface ApprovalHandle {
    readonly id: string;
    readonly outcome: Promise<ApprovalOutcome>;
    /** Withdraw without answering, reporting how it was settled elsewhere. */
    abandon(outcome: ApprovalOutcome): void;
}
/** A handle on one outstanding question batch. */
export interface QuestionHandle {
    readonly id: string;
    readonly answers: Promise<readonly unknown[]>;
    /** Withdraw without answering. */
    abandon(): void;
}
/**
 * Route interactions to the desktop and take the first answer.
 *
 * Transport-agnostic: the sender is attached once the link exists, and a link
 * that goes away is reported through {@link setConnected}.
 */
export declare class InteractionBroker {
    #private;
    /** Attach the link. Before this, requests are recorded but not announced. */
    setSender(send: (frame: FrameToDesktop) => boolean): void;
    /** Whether a desktop could answer right now. */
    hasDesktop(): boolean;
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
    setConnected(connected: boolean): void;
    /** Re-send every pending request, for a desktop that just connected. */
    republish(): void;
    /**
     * Ask the desktop for an approval decision.
     * @param request - DSH's own payload, forwarded as-is.
     * @param signal - aborts when the requesting tool withdraws.
     */
    beginApproval(request: unknown, signal?: AbortSignal): ApprovalHandle;
    /**
     * Ask the desktop for answers to a question batch.
     * @param request - DSH's own payload, forwarded as-is.
     * @param ids - the question ids in the batch, for validating the reply.
     * @param signal - aborts when the asking tool withdraws.
     */
    beginQuestions(request: unknown, ids: readonly string[], signal?: AbortSignal): QuestionHandle;
    /**
     * Apply one answer frame.
     *
     * @param id - the request id the desktop was given.
     * @param frame - the answer, as parsed from the link.
     * @returns whether it settled something still pending.
     * @throws LinkError when a question reply does not name each question once.
     */
    answer(id: string, frame: {
        outcome?: string;
        answers?: readonly unknown[];
    }): boolean;
    /** Release everything still pending, for plugin unload. */
    dispose(): void;
    /** The approvals still awaiting an answer. Diagnostics only. */
    get pendingApprovals(): number;
    /** The question batches still awaiting an answer. Diagnostics only. */
    get pendingQuestions(): number;
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
export declare function assertAnswerBatch(ids: readonly string[], answers: readonly unknown[]): void;
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
export declare function readQuestionIds(request: unknown): string[] | null;
/**
 * Register both waterfall answerers.
 *
 * @param ctx - the plugin context; listeners leave with it.
 * @param broker - the interaction broker.
 */
export declare function registerAnswerers(ctx: Context, broker: InteractionBroker): void;
