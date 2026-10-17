import { deliverQuestionAnswers } from './answerers.js';
import { toMethodError } from './errors.js';
import { CLIENT_APPROVAL_OUTCOMES, InteractionBroker, } from './interactions.js';
import { MethodError, optionalBoolean, optionalObject, optionalString, requireString } from './method-error.js';
import { modelCatalog, selectModel } from './models.js';
import { permissionCatalog, setPermissionPreset } from './permissions.js';
import { listWorkspaces } from './workspaces.js';
import { cancelSession, createSession, listSessions, promptSession, renameSession, sessionMessages, sessionStats, } from './sessions.js';
/**
 * Translate any thrown value into a wire-coded failure.
 * @param handler - the raw implementation.
 * @returns the guarded implementation.
 */
function guard(handler) {
    return async (payload, context) => {
        try {
            return await handler(payload, context);
        }
        catch (error) {
            throw toMethodError(error);
        }
    };
}
/**
 * Read the optional delivery mode for a prompt.
 * @param payload - the request payload.
 * @returns the mode, defaulting to `queue`.
 */
function readMode(payload) {
    const mode = optionalString(payload, 'mode');
    if (mode === undefined)
        return 'queue';
    if (mode !== 'queue' && mode !== 'steer') {
        throw new MethodError('MALFORMED_FRAME', `session.prompt: mode must be "queue" or "steer", got "${mode}"`);
    }
    return mode;
}
/**
 * Read a client answer batch for a question.
 * @param payload - the request payload.
 * @returns the batch, already narrowed.
 * @throws MethodError when an item is not `{id, selected}`.
 */
function readAnswerBatch(payload) {
    const record = optionalObject(payload, 'question.answer');
    const raw = record['answers'];
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new MethodError('MALFORMED_FRAME', 'question.answer: payload."answers" must be a non-empty array');
    }
    return raw.map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new MethodError('MALFORMED_FRAME', 'question.answer: each answer must be an object');
        }
        const item = entry;
        if (typeof item['id'] !== 'string' || item['id'] === '') {
            throw new MethodError('MALFORMED_FRAME', 'question.answer: each answer needs a string "id"');
        }
        const selected = item['selected'];
        if (!Array.isArray(selected) || selected.some((value) => typeof value !== 'string')) {
            throw new MethodError('MALFORMED_FRAME', `question.answer: answer "${item['id']}" needs "selected" as an array of strings`);
        }
        const custom = item['custom'];
        if (custom !== undefined && typeof custom !== 'string') {
            throw new MethodError('MALFORMED_FRAME', `question.answer: answer "${item['id']}" has a non-string "custom"`);
        }
        return {
            id: item['id'],
            selected: selected,
            ...(typeof custom === 'string' ? { custom } : {}),
        };
    });
}
/**
 * Read a `push.register`'s platform and environment.
 *
 * `platform` is optional and means iOS when absent, which is the one thing that
 * makes this change compatible: every app build that exists today sends
 * `{token, environment, locale}` and none of them can be made to send a new
 * field before the relay and the plugin know what to do with it.
 *
 * `environment` is required for iOS and ignored for Android. Required rather
 * than defaulted, and for the reason it always was: a token minted for the
 * sandbox is rejected by the production endpoint with `BadDeviceToken`, which
 * says nothing about the real mistake -- so guessing here turns a clear client
 * bug into an unexplained silence, and the client always knows the answer. An
 * Android client has no answer to give, so it is not asked, and a stray value
 * is dropped rather than rejected: FCM has one service and the field is
 * meaningless there.
 *
 * @param payload - the request payload.
 * @returns the platform, and the environment when there is one.
 * @throws MethodError when either is present but not one of the allowed values.
 */
function readRegistration(payload) {
    const record = optionalObject(payload, 'push.register');
    const platform = record['platform'] ?? 'ios';
    if (platform !== 'ios' && platform !== 'android') {
        throw new MethodError('MALFORMED_FRAME', 'push.register: payload."platform" must be "ios" or "android"');
    }
    const value = record['environment'];
    if (platform === 'android') {
        // Dropped rather than passed on or refused. FCM has one service, so there is
        // nothing for an Android client to answer here -- and a client that sends
        // one anyway must still register, because refusing would make a version of
        // the app unable to pair for a reason that cannot be true.
        return { platform, environment: null };
    }
    if (value !== 'sandbox' && value !== 'production') {
        throw new MethodError('MALFORMED_FRAME', 'push.register: payload."environment" must be "sandbox" or "production" for platform "ios"');
    }
    return { platform, environment: value };
}
/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients.
 * @param broker - the interaction broker holding pending approvals and questions.
 * @param push - where a device's notification endpoint is recorded, when the host
 *   has push at all. Absent in compositions without a relay.
 * @returns the table, keyed by wire method name.
 */
export function createMethodTable(ctx, facts, broker, push) {
    const table = {
        /** Host identity and protocol facts. */
        'host.info': async () => ({
            hostId: facts.hostId,
            hostName: facts.hostName,
            home: facts.home,
            protocolVersion: facts.protocolVersion,
        }),
        /** Every session DSH would list, newest activity first. */
        'session.list': async () => listSessions(ctx),
        /**
         * The workspaces DSH has, by directory, with the sessions filed under each.
         *
         * Separate from the session list because they are separate things: a session
         * outlives the workspace it was created in, so grouping sessions by their
         * working directory draws a row for every directory that has ever held one,
         * including the workspaces an operator has deleted.
         *
         * `complete` says whether the list was actually read. The phone may only
         * drop a workspace it can no longer see when it was; otherwise an empty
         * array is indistinguishable from "this host cannot answer", and the
         * deleted workspaces stay on screen.
         */
        'workspace.list': async () => listWorkspaces(ctx),
        /**
         * One session's usage frame. Works for a cold session: the projection read
         * does not activate an agent.
         */
        'session.stats': async (payload) => sessionStats(ctx, requireString(payload, 'sessionId', 'session.stats')),
        /**
         * One page of a session's history, summarised.
         *
         * The cut comes from the `session/follow` opening frame and the records are
         * narrowed to what a conversation screen draws -- prompts, turn boundaries,
         * one marker per step, and one assistant message per finished turn. See
         * `sessionMessages` for what that leaves out and the measurements behind it.
         */
        'session.messages': async (payload) => {
            const limit = payload?.['maxMessages'];
            const before = payload?.['beforeSeq'];
            return sessionMessages(ctx, requireString(payload, 'sessionId', 'session.messages'), typeof limit === 'number' ? limit : undefined, typeof before === 'number' ? before : undefined);
        },
        /**
         * Create a session, or adopt/resume one when `sessionId` is supplied.
         *
         * Every argument is optional, so the payload is validated for *type* here:
         * a non-object payload must report a mistake, not quietly create a session
         * with defaults.
         */
        'session.create': async (payload) => {
            const args = optionalObject(payload, 'session.create');
            return createSession(ctx, {
                workspaceId: optionalString(args, 'workspaceId'),
                cwd: optionalString(args, 'cwd'),
                sessionId: optionalString(args, 'sessionId'),
                agentPreset: optionalString(args, 'agentPreset'),
            });
        },
        /**
         * Send a prompt. The client should reuse one `requestId` across retries:
         * the host treats it as an idempotency key and will not insert the same
         * message twice.
         */
        'session.prompt': async (payload) => promptSession(ctx, {
            sessionId: requireString(payload, 'sessionId', 'session.prompt'),
            text: requireString(payload, 'text', 'session.prompt'),
            mode: readMode(payload),
            requestId: optionalString(payload, 'requestId'),
            clientTimeZone: optionalString(payload, 'clientTimeZone'),
        }),
        /** Interrupt the running turn. */
        'session.cancel': async (payload) => cancelSession(ctx, requireString(payload, 'sessionId', 'session.cancel')),
        /** Rename a session. */
        'session.rename': async (payload) => {
            await renameSession(ctx, requireString(payload, 'sessionId', 'session.rename'), requireString(payload, 'title', 'session.rename'));
            return { renamed: true };
        },
        /** The model catalog the picker renders, with each model's reasoning levels. */
        'model.catalog': async () => modelCatalog(ctx),
        /** Select the model and reasoning effort for one session. */
        'session.model.set': async (payload) => {
            const effort = optionalString(payload, 'reasoningEffort');
            return selectModel(ctx, {
                sessionId: requireString(payload, 'sessionId', 'session.model.set'),
                provider: requireString(payload, 'provider', 'session.model.set'),
                model: requireString(payload, 'model', 'session.model.set'),
                ...(effort === undefined ? {} : { reasoningEffort: effort }),
            });
        },
        /** The permission presets this host currently offers. */
        'permissions.catalog': async () => permissionCatalog(ctx),
        /** Switch one session's permission preset. */
        'session.permission.set': async (payload) => setPermissionPreset(ctx, {
            sessionId: requireString(payload, 'sessionId', 'session.permission.set'),
            preset: requireString(payload, 'preset', 'session.permission.set'),
        }),
        /**
         * Everything waiting on the operator right now.
         *
         * A client reconnecting after a dropped socket has no other way to discover
         * a question that was asked while it was away — ordinary notifications are
         * never replayed.
         */
        'interactions.pending': async () => ({
            approvals: broker.listApprovals(),
            questions: broker.listQuestions(),
        }),
        /** Answer an approval. Only `allowed-once` grants the action. */
        'approval.answer': async (payload) => {
            const requestId = requireString(payload, 'requestId', 'approval.answer');
            const outcome = requireString(payload, 'outcome', 'approval.answer');
            if (!CLIENT_APPROVAL_OUTCOMES.includes(outcome)) {
                throw new MethodError('MALFORMED_FRAME', `approval.answer: outcome must be one of ${CLIENT_APPROVAL_OUTCOMES.join(', ')}`);
            }
            return { accepted: broker.answerApproval(requestId, outcome) };
        },
        /**
         * Answer a question batch.
         *
         * Only works while the batch is still pending *here*. A batch the host
         * already timed out is answered through the late path instead, which the
         * question's own projection reports as `continued`.
         */
        'question.answer': async (payload) => {
            const callId = requireString(payload, 'callId', 'question.answer');
            return { accepted: deliverQuestionAnswers(broker, callId, readAnswerBatch(payload)) };
        },
        /**
         * Record where this device can be reached by a notification.
         *
         * Called by the app once it has a token, which is after the operator grants
         * notification permission -- so a phone that refused simply never calls it,
         * and nothing needs to model refusal.
         *
         * Answers `registered: false` rather than failing when the device is not on
         * the roster. That cannot happen through the listener (every method is behind
         * authentication), and a client that met it would have nothing useful to do
         * with an error.
         */
        'push.register': async (payload, context) => {
            if (push === undefined)
                return { registered: false };
            // The token is read first so that a payload with nothing at all is
            // answered with the same complaint it always was: whichever field is
            // missing, the client gets a `MALFORMED_FRAME` naming it.
            const token = requireString(payload, 'token', 'push.register');
            const registration = readRegistration(payload);
            return {
                registered: await push.register(context.deviceId, {
                    token,
                    platform: registration.platform,
                    environment: registration.environment,
                    locale: optionalString(payload, 'locale') ?? 'en',
                }),
            };
        },
        /**
         * Say whether this device's app is on screen.
         *
         * Separate from `push.register` because it happens constantly -- every time
         * the operator switches apps -- and the registration is what tells the relay
         * where the device is. Folding them would put an HTTP request to the relay
         * behind every app switch.
         */
        'push.presence': async (payload, context) => {
            const foreground = optionalBoolean(payload, 'foreground');
            if (foreground === undefined) {
                throw new MethodError('MALFORMED_FRAME', 'push.presence: payload."foreground" must be a boolean');
            }
            push?.presence(context.deviceId, foreground);
            return { accepted: true };
        },
        /** Forget this device's notification endpoint, here and at the relay. */
        'push.unregister': async (_payload, context) => {
            if (push === undefined)
                return { unregistered: false };
            return { unregistered: await push.unregister(context.deviceId) };
        },
    };
    return Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, guard(handler)]));
}
