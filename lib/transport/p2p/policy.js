/**
 * The tunable numbers of a MizarNet connection.
 *
 * The same values the Swift kernel ships, because they are part of how the two
 * implementations behave towards each other: a punch interval one side takes
 * ten times longer over is a punch the other side already gave up on.
 *
 * @module dsh-mizar/transport/p2p/policy
 */
/** The defaults, identical to `MizarNetPathPolicy.standard`. */
export const STANDARD_POLICY = {
    punchBudgetMs: 3000,
    keepaliveIntervalMs: 22_000,
    punchRounds: 8,
    punchIntervalMs: 120,
    streamChunkBytes: 1024,
    stunBudgetMs: 700,
    acceptorPunchWindowMs: 4000,
    punchAnswerGraceMs: 150,
    candidateGraceMs: 1000,
};
