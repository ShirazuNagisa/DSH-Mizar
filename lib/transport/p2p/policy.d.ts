/**
 * The tunable numbers of a MizarNet connection.
 *
 * The same values the Swift kernel ships, because they are part of how the two
 * implementations behave towards each other: a punch interval one side takes
 * ten times longer over is a punch the other side already gave up on.
 *
 * @module dsh-mizar/transport/p2p/policy
 */
/** The policy a production connection uses. */
export interface Policy {
    /** How long a dial — punch included — may take. */
    readonly punchBudgetMs: number;
    /** How often an idle path is kept alive. */
    readonly keepaliveIntervalMs: number;
    /** How many times the dial resends its hello across all candidates. */
    readonly punchRounds: number;
    /** The pause between punch rounds. */
    readonly punchIntervalMs: number;
    /** The largest plaintext chunk one datagram carries. */
    readonly streamChunkBytes: number;
    /** How long to wait for a STUN answer before punching without one. */
    readonly stunBudgetMs: number;
    /** How long the side being dialled keeps punching back. */
    readonly acceptorPunchWindowMs: number;
    /** How long an answered punch-back waits before its session is offered. */
    readonly punchAnswerGraceMs: number;
    /** How long a dial waits for the peer's candidates before giving up. */
    readonly candidateGraceMs: number;
}
/** The defaults, identical to `MizarNetPathPolicy.standard`. */
export declare const STANDARD_POLICY: Policy;
