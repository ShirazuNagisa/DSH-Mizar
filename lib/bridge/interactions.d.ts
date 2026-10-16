/**
 * Approval and question brokering.
 *
 * These are the two interactions that make remote *guidance* possible: an agent
 * that stops to ask permission, and an agent that stops to ask a question. Both
 * are Cordis **waterfall** events on the host, and both are already answered by
 * whatever else is composed — the desktop GUI, through the forwarded `$events`
 * source, and the built-in terminal answerer.
 *
 * ### Why this registers with `prepend: true`
 *
 * A waterfall runs its listeners outermost-first and stops at the first one that
 * does not call `next()`. Registration order is mount order, and this plugin
 * mounts *after* the API layer, so a plainly registered listener would only ever
 * run when nobody else claimed the request — which, with the desktop GUI open,
 * is never. The phone would silently never see an approval. Prepending puts the
 * phone in the race as a peer rather than as a last resort.
 *
 * ### Why `next()` is raced rather than awaited
 *
 * The waterfall's terminal `next()` returns the event's built-in behaviour,
 * which for both of these is "nobody is answering" — `unavailable` for an
 * approval. Racing that directly would resolve instantly and the phone could
 * never answer. So the delegated outcome is treated as *a claim only when it is
 * a real answer*, and `unavailable` is read as "the rest of the chain declined",
 * leaving the phone's question outstanding.
 *
 * The result is the documented multi-client semantic: every channel is asked at
 * once and the first real answer wins.
 *
 * @module dsh-mizar/bridge/interactions
 */
import type { Context } from '../dsh.js';
import { type ServerFrame } from '../protocol/frames.js';
/** Outcomes a client may choose for an approval. */
export declare const CLIENT_APPROVAL_OUTCOMES: readonly ["allowed-once", "rejected"];
/** One client-chosen approval outcome. */
export type ClientApprovalOutcome = (typeof CLIENT_APPROVAL_OUTCOMES)[number];
/** The full outcome vocabulary DSH accepts. */
export type ApprovalOutcome = ClientApprovalOutcome | 'cancelled' | 'unavailable';
/** One option of a question. */
export interface QuestionOption {
    readonly label: string;
    readonly description?: string;
}
/** One question in a batch. */
export interface QuestionItem {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options: readonly QuestionOption[];
    readonly multiSelect: boolean;
    /** Set when the question is a plan awaiting approval. */
    readonly intent: {
        kind: 'plan-review';
        approve: string;
    } | null;
}
/** A pending approval, as shown to the phone. */
export interface PendingApprovalView {
    readonly requestId: string;
    readonly sessionId: string | null;
    readonly toolName: string;
    readonly callId: string | null;
    readonly reason: string | null;
    /** Localized presentation text, when the requesting tool supplied one. */
    readonly displayReason: Record<string, string> | null;
    /** Epoch milliseconds the host first asked. */
    readonly requestedAt: number;
}
/** A pending question batch, as shown to the phone. */
export interface PendingQuestionView {
    readonly callId: string;
    readonly sessionId: string | null;
    readonly questions: readonly QuestionItem[];
    readonly requestedAt: number;
}
/** The answer to one question item. */
export interface QuestionAnswerItem {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
}
/** A handle on one outstanding approval. */
export interface ApprovalHandle {
    /** The id the phone answers with. */
    readonly requestId: string;
    /** Settles with the outcome, whenever it arrives. */
    readonly outcome: Promise<ApprovalOutcome>;
    /**
     * Withdraw the question without answering it, reporting how it was settled.
     * @param outcome - the outcome another channel produced.
     */
    abandon(outcome: ApprovalOutcome): void;
}
/** A handle on one outstanding question batch. */
export interface QuestionHandle {
    /** The call id the phone answers with. */
    readonly callId: string;
    /** Settles with the answers, empty when withdrawn. */
    readonly answers: Promise<readonly QuestionAnswerItem[]>;
    /** Withdraw the question without answering it. */
    abandon(): void;
}
export declare class InteractionBroker {
    #private;
    /**
     * Attach the transport. Called once the listener is listening; before that,
     * notifications are dropped rather than queued, because a client that is not
     * connected cannot answer anyway and the request is still visible through
     * {@link listPending}.
     * @param send - delivers one frame to every authenticated client.
     */
    setSender(send: (frame: ServerFrame) => void): void;
    /** Whether any authenticated client could answer right now. */
    hasClients(): boolean;
    /**
     * Report the current authenticated client count.
     *
     * Dropping to zero is a fail-closed trigger rather than a silent state change:
     * an approval is a one-shot decision tied to an open turn, with no late-answer
     * path, so a phone that vanished mid-question must not leave the agent
     * waiting forever. Pending approvals settle `unavailable` — the same outcome
     * DSH itself uses when there is no answerer — and pending questions settle
     * empty, which the host records as unanswered.
     *
     * This can preempt a desktop UI that is still showing the card. That is the
     * deliberate trade: a refused tool action is recoverable, a hung agent is not.
     *
     * @param count - the number of authenticated clients.
     */
    setClientCount(count: number): void;
    /** Every approval still awaiting an answer. */
    listApprovals(): PendingApprovalView[];
    /** Every question batch still awaiting an answer. */
    listQuestions(): PendingQuestionView[];
    /**
     * Answer one pending approval.
     * @param requestId - the approval to answer.
     * @param outcome - the client's choice.
     * @returns whether the approval was still pending.
     */
    answerApproval(requestId: string, outcome: ClientApprovalOutcome): boolean;
    /**
     * Answer one pending question batch.
     * @param callId - the question batch to answer.
     * @param answers - one entry per question, naming each exactly once.
     * @returns whether the question was still pending here.
     */
    answerQuestion(callId: string, answers: readonly QuestionAnswerItem[]): boolean;
    /** Release everything still pending, for plugin unload. */
    dispose(): void;
    /**
     * Ask the phone for an approval decision.
     *
     * Returns a handle rather than a bare promise so a caller that loses a race to
     * another channel can {@link ApprovalHandle.abandon} the question. Without
     * that, the phone keeps showing a card for a decision already taken
     * elsewhere — and the pending entry leaks for the life of the process.
     *
     * @param input - the agent's request, already narrowed from the Cordis event.
     * @param signal - aborts when the requesting tool withdraws the question.
     * @returns the request id and its outcome promise.
     */
    beginApproval(input: {
        sessionId: string | null;
        toolName: string;
        callId?: string;
        reason?: string;
        displayReason?: Record<string, string>;
    }, signal?: AbortSignal): ApprovalHandle;
    /**
     * Ask the phone for answers to a question batch.
     *
     * There is no window of its own: the asking tool's signal is what withdraws a
     * batch, and a timer here would settle a question the operator can still
     * answer. (A constant claiming otherwise used to live above this class and was
     * read by nothing.)
     *
     * @param input - the question batch, already narrowed from the Cordis event.
     * @param signal - aborts when the asking tool withdraws.
     * @returns the call id and its answer promise.
     */
    beginQuestions(input: {
        sessionId: string | null;
        callId: string;
        questions: readonly QuestionItem[];
    }, signal?: AbortSignal): QuestionHandle;
}
/**
 * Narrow a raw `approval/request` event into the broker's input.
 * @param request - the Cordis event payload.
 * @returns the narrowed input.
 */
export declare function readApprovalRequest(request: unknown): {
    sessionId: string | null;
    toolName: string;
    callId?: string;
    reason?: string;
    displayReason?: Record<string, string>;
};
/**
 * Narrow a raw `user-questions/request` event into the broker's input.
 * @param request - the Cordis event payload.
 * @returns the narrowed input, or `null` when it carries no usable call id.
 */
export declare function readQuestionRequest(request: unknown): {
    sessionId: string | null;
    callId: string;
    questions: QuestionItem[];
} | null;
/**
 * Validate a client's answer batch against the questions it answers.
 *
 * DSH requires the batch to name every question of the call exactly once, and
 * rejects the whole reply otherwise, so the check happens here rather than
 * letting the host refuse a reply the operator already committed to.
 *
 * @param questions - the questions that were asked.
 * @param answers - the client's batch.
 * @throws MethodError when the batch does not match.
 */
export declare function assertAnswerBatch(questions: readonly QuestionItem[], answers: readonly QuestionAnswerItem[]): void;
/** Re-exported so the wiring module can build the Cordis listener signature. */
export type { Context };
