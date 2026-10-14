/**
 * The two waterfall answerers.
 *
 * Each registers with `prepend: true` so the phone is asked as a peer alongside
 * the desktop GUI rather than after it, then races the phone against the
 * delegated chain. See `interactions.ts` for why both of those choices are
 * load-bearing.
 *
 * The delegated outcome is only treated as a claim when it is a *real* answer.
 * The waterfall's terminal behaviour is "nobody answered" — `unavailable` for an
 * approval — and racing that verbatim would resolve instantly, meaning the phone
 * could never answer at all.
 *
 * @module dsh-mizar/bridge/answerers
 */
import type { Context } from '../dsh.js';
import { InteractionBroker, type QuestionAnswerItem } from './interactions.js';
/**
 * Register both answerers on the plugin's context.
 *
 * @param ctx - the plugin context; listeners are effect-scoped to it and leave
 *   with the plugin.
 * @param broker - the interaction broker delivering questions to clients.
 */
export declare function registerAnswerers(ctx: Context, broker: InteractionBroker): void;
/**
 * Validate an answer batch the phone sent for a batch it was already shown.
 *
 * The expected question ids come from the broker's pending view, so this checks
 * the reply against what was actually asked rather than against whatever the
 * client claims.
 *
 * @param broker - the interaction broker.
 * @param callId - the question batch being answered.
 * @param answers - the client's batch.
 * @returns whether the batch was accepted and delivered.
 * @throws MethodError when the batch does not name every question exactly once.
 */
export declare function deliverQuestionAnswers(broker: InteractionBroker, callId: string, answers: readonly QuestionAnswerItem[]): boolean;
