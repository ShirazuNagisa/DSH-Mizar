/**
 * The method table.
 *
 * One place where wire method names map to bridge calls. Keeping it separate
 * from the listener is what lets `server/listener.ts` stay transport-only: it
 * moves frames and enforces authentication, and knows nothing about sessions.
 * Every DSH-shaped decision lives here or below.
 *
 * Every handler is wrapped by {@link guard}, so an upstream DSH failure leaves
 * as a code the app can branch on instead of a bare `INTERNAL`.
 *
 * @module dsh-mizar/bridge
 */
import { join } from 'node:path';
import { isLiveActivityToken } from '../auth/devices.js';
import { deliverQuestionAnswers } from './answerers.js';
import { accountBalance } from './balance.js';
import { toMethodError } from './errors.js';
import { CLIENT_APPROVAL_OUTCOMES, InteractionBroker, } from './interactions.js';
import { MethodError, optionalBoolean, optionalObject, optionalString, requireObject, requireString } from './method-error.js';
import { modelCatalog, selectModel } from './models.js';
import { permissionCatalog, setPermissionPreset } from './permissions.js';
import { archiveSession, listWorkspaces } from './workspaces.js';
import { cancelSession, createSession, forkSession, listSessions, promptSession, renameSession, sessionActivity, sessionMessages, sessionStats, } from './sessions.js';
import { parseUploadBegin, parseUploadChunk, PromptReplayGuard, UploadStore } from './uploads.js';
import { canonicalRelayURL, isSelectableRelayURL } from '../relay/selection.js';
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
 * Read whether an archive may stop the session's running work.
 *
 * Absent is `false`, which is the gesture the phone's long-press menu performs:
 * archive a session that is not running, and let the host refuse one that is.
 * Silently killing a turn somebody is watching is not what "归档该会话" means.
 *
 * A present value that is not a boolean is a mistake rather than an omission.
 * This call changes the host, and quietly reading garbage as "do not stop"
 * would turn a client bug into a refusal an operator cannot explain.
 *
 * @param payload - the request payload.
 * @returns whether the host may stop running work.
 * @throws MethodError when the field is present but not a boolean.
 */
function readStopActivity(payload) {
    const record = requireObject(payload, 'session.archive');
    const value = record['stopActivity'];
    if (value === undefined)
        return false;
    if (typeof value !== 'boolean') {
        throw new MethodError('MALFORMED_FRAME', 'session.archive: payload."stopActivity" must be a boolean');
    }
    return value;
}
/**
 * Read the optional backwards-page cursor for `session.activity`.
 *
 * `beforeSeq` changes the read from "the newest window" to "the window before
 * this position", so the pair is validated rather than treated as hints. A
 * `beforeSeq` without a `turn` cannot be answered honestly: the page it names
 * spans earlier turns too, and guessing which one the caller means would append
 * another turn's rows to a feed. A `turn` without `beforeSeq` is ignored -- a
 * forward read finds its own running turn.
 *
 * A present value that is not a usable number is a mistake, not an omission:
 * quietly answering the newest page for a scrolling reader would hand them the
 * wrong end of the log and look like a successful older page.
 *
 * @param payload - the request payload.
 * @returns the cursor, or an empty object for a forward read.
 * @throws MethodError when `beforeSeq` is present without a usable `turn`.
 */
function readActivityCursor(payload) {
    const fields = requireObject(payload, 'session.activity');
    const beforeSeq = fields['beforeSeq'];
    if (beforeSeq === undefined)
        return {};
    if (typeof beforeSeq !== 'number' || !Number.isFinite(beforeSeq) || beforeSeq < 0) {
        throw new MethodError('MALFORMED_FRAME', 'session.activity: payload."beforeSeq" must be a non-negative number');
    }
    const turn = fields['turn'];
    if (turn === undefined) {
        throw new MethodError('MALFORMED_FRAME', 'session.activity: payload."turn" is required when "beforeSeq" is given');
    }
    if (typeof turn !== 'number' || !Number.isFinite(turn) || turn < 0) {
        throw new MethodError('MALFORMED_FRAME', 'session.activity: payload."turn" must be a non-negative number when "beforeSeq" is given');
    }
    return { beforeSeq, turn };
}
/**
 * Read a prompt's text, which is optional when attachments are present.
 *
 * Absent and empty both mean "there is no text part". A present value that is
 * not a string is a mistake rather than an omission: silently dropping it would
 * send a prompt the client did not mean to send.
 *
 * @param payload - the request payload.
 * @returns the text, or `undefined` when there is none.
 * @throws MethodError when the field is present but not a string.
 */
function readPromptText(payload) {
    const record = optionalObject(payload, 'session.prompt');
    const value = record['text'];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new MethodError('MALFORMED_FRAME', 'session.prompt: payload."text" must be a string');
    }
    return value === '' ? undefined : value;
}
/**
 * Read the attachment ids a prompt refers to.
 *
 * Shape only -- whether each id names a usable attachment is the upload store's
 * question, and its answer is a specific code (`ATTACHMENT_UNKNOWN`) rather than
 * a generic malformed frame.
 *
 * @param payload - the request payload.
 * @returns the ids, empty when the field is absent.
 * @throws MethodError when the field is present but not an array of non-empty strings.
 */
function readAttachmentIds(payload) {
    const record = optionalObject(payload, 'session.prompt');
    const value = record['attachmentIds'];
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        throw new MethodError('MALFORMED_FRAME', 'session.prompt: payload."attachmentIds" must be an array of strings');
    }
    return value.map((entry) => {
        if (typeof entry !== 'string' || entry === '') {
            throw new MethodError('MALFORMED_FRAME', 'session.prompt: payload."attachmentIds" must contain non-empty strings');
        }
        return entry;
    });
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
 * Read the optional Live Activity token a registration carries.
 *
 * Absence is meaningful rather than "no change": the app only sends this while
 * a Live Activity is up, so a registration without it says none is up now and
 * the stored token must be cleared. That is why the answer is `string | null`
 * rather than `string | undefined` -- the binding has to act on the absence.
 *
 * A present value is held, not just forwarded, because it has to outlive this
 * launch: the relay is told again after a reconnect, and the app may be
 * suspended long before the turn that ends the activity.
 *
 * @param record - the registration payload.
 * @returns the token, or `null` when the app has no Live Activity up.
 * @throws MethodError when a value is present but is not a usable token.
 */
function readLiveActivityToken(record) {
    const value = record['liveActivityToken'];
    // Absent, not null and not empty: those are present values that failed the
    // contract, and a client sending one has a bug worth naming rather than
    // silently having its activity token cleared.
    if (value === undefined)
        return null;
    if (!isLiveActivityToken(value)) {
        throw new MethodError('MALFORMED_FRAME', 'push.register: payload."liveActivityToken" must be 1-200 lowercase hex characters');
    }
    return value;
}
/**
 * Read a `push.register`'s platform, environment and Live Activity token.
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
 * `liveActivityToken` is likewise iOS-only and optional. An Android client has
 * no Live Activity to end, so a stray value is dropped rather than refused, for
 * the same reason a stray environment is.
 *
 * @param payload - the request payload.
 * @returns the platform, the environment and the activity token when there are any.
 * @throws MethodError when a present field is not one of the allowed values.
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
        return { platform, environment: null, liveActivityToken: null };
    }
    if (value !== 'sandbox' && value !== 'production') {
        throw new MethodError('MALFORMED_FRAME', 'push.register: payload."environment" must be "sandbox" or "production" for platform "ios"');
    }
    return { platform, environment: value, liveActivityToken: readLiveActivityToken(record) };
}
/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients, including the state directory
 *   the upload staging area lives under and, when the host can say, the bound
 *   listener addresses.
 * @param broker - the interaction broker holding pending approvals and questions.
 * @param push - where a device's notification endpoint is recorded, when the host
 *   has push at all. Absent in compositions without a relay.
 * @param delivery - what each device has already been sent, when the host keeps
 *   it. Absent leaves every page full: a composition without it still answers,
 *   it just does not save the phone the bytes it already read.
 * @param uploads - the attachment staging store. Absent builds one under
 *   `facts.home`; a caller that wants to share or test one may pass it.
 * @returns the table, keyed by wire method name.
 */
export function createMethodTable(ctx, facts, broker, push, delivery, uploads) {
    const uploadStore = uploads ??
        new UploadStore({
            root: join(facts.home, 'uploads'),
            attachmentsRoot: join(facts.home, 'attachments'),
        });
    // A prompt that carries attachments is retried with the same requestId when
    // its answer is lost. That is safe only while the request is identical: DSH
    // deduplicates by (session, requestId), so the same key with different
    // content must be refused before it can borrow the first answer. Ported
    // from XEPX2's PR #2.
    const replayGuard = new PromptReplayGuard();
    const relay = facts.relay;
    const table = {
        /**
         * Host identity and protocol facts.
         *
         * `addresses`, when present, is the listener's own bound `host:port` list.
         * It exists so a phone connected through the relay can learn where to try
         * the computer directly: the relay route never tells it a LAN address, and
         * probing the paired one again is not a scan.
         *
         * Additive and optional, so it needs no protocol version bump -- an old
         * client ignores the key, and an old host simply does not send it.
         */
        'host.info': async () => ({
            hostId: facts.hostId,
            hostName: facts.hostName,
            home: facts.home,
            protocolVersion: facts.protocolVersion,
            plugin: { id: 'dsh-mizar', capabilities: ['deepseek.balance.v1'] },
            ...(facts.authorities === undefined ? {} : { addresses: facts.authorities() }),
            ...(relay === undefined ? {} : { relay: relay.current() }),
        }),
        /** Native official-account wallets; no account grant or identity leaves the host. */
        'account.balance': async (payload) => accountBalance(ctx, payload),
        /**
         * Move this computer's tunnel to the free or the paid relay.
         *
         * The phone asks because only the phone knows the account tier; the host
         * owns the allowlist and the persistence so a paired device cannot point
         * this computer's tunnel at an arbitrary server. The tunnel credential is
         * unchanged, so the room is unchanged and every existing pairing survives;
         * what changes is the address a phone dials, and the answer carries it.
         *
         * Additive, so no protocol version bump: an old host answers
         * `NOT_IMPLEMENTED`, which is how the app knows to keep its current relay.
         */
        ...(relay === undefined
            ? {}
            : {
                'relay.set': async (payload) => {
                    const requested = requireString(payload, 'url', 'relay.set');
                    const canonical = canonicalRelayURL(requested);
                    if (canonical === null || !isSelectableRelayURL(canonical)) {
                        throw new MethodError('MALFORMED_FRAME', 'relay.set: payload."url" must be the free or the paid relay');
                    }
                    return relay.set(canonical);
                },
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
         *
         * A refresh may also say what it already holds, and only new records travel.
         * `afterSeq` is a number (the phone's cursor), `null` (the phone holds
         * nothing and needs a full page), or absent -- in which case the ledger
         * answers with what was last actually delivered to this device.
         */
        'session.messages': async (payload, context) => {
            const fields = payload;
            const limit = fields?.['maxMessages'];
            const before = fields?.['beforeSeq'];
            const after = fields?.['afterSeq'];
            const sessionId = requireString(payload, 'sessionId', 'session.messages');
            // A delegated child is not addressable as a session: the host refuses the
            // read with `session/agent-busy` unless the child is named through its
            // parent. The phone knows the lineage from `session.list` and sends it
            // back here, so the address can be rebuilt on the way in.
            const parentSessionId = optionalString(payload, 'parentSessionId');
            const explicit = typeof after === 'number' && Number.isFinite(after) ? after : undefined;
            // `null` is the phone saying it holds nothing -- a reinstall, a cleared
            // cache. Silence is not that claim: it is a request with no cursor, which
            // the ledger may answer from what it delivered.
            const holdsNothing = after === null;
            const remembered = holdsNothing || explicit !== undefined
                ? undefined
                : delivery?.deliveredThrough(context.deviceId, sessionId);
            return sessionMessages(ctx, sessionId, typeof limit === 'number' ? limit : undefined, typeof before === 'number' ? before : undefined, explicit ?? remembered, parentSessionId);
        },
        /**
         * The running turn's compact process detail.
         *
         * Separate from `session.messages` because it answers a different question
         * and changes far more often: a summary refresh is a page of conversation,
         * this is polled a couple of times a second while a turn runs, and the paid
         * account's UI draws it as a full-detail feed under the status row. The
         * answer carries only the running turn's one-line process rows; see
         * `sessionActivity` for what is mapped and the byte budget it enforces.
         *
         * `maxEntries` is a hint, not a promise: the host clamps it to the protocol
         * ceiling and may return fewer rows when the byte budget fills.
         *
         * `beforeSeq` + `turn` ask for the page *before* a position instead of the
         * newest one. That is how a scrolling reader loads the older rows of a long
         * turn: the answer's `oldestSeq` is the cursor for the next request. Without
         * `beforeSeq` the read is exactly what it always was.
         */
        'session.activity': async (payload) => {
            const fields = requireObject(payload, 'session.activity');
            const maxEntries = fields['maxEntries'];
            const cursor = readActivityCursor(payload);
            return sessionActivity(ctx, requireString(payload, 'sessionId', 'session.activity'), typeof maxEntries === 'number' && Number.isFinite(maxEntries) ? maxEntries : undefined, cursor.beforeSeq, cursor.turn);
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
        /** Fork the exact completed-turn prefix selected by the phone. */
        'session.fork': async (payload) => {
            const args = requireObject(payload, 'session.fork');
            const atSeq = args['atSeq'];
            if (typeof atSeq !== 'number' || !Number.isSafeInteger(atSeq) || atSeq < 0) {
                throw new MethodError('MALFORMED_FRAME', 'session.fork: payload."atSeq" must be a non-negative safe integer');
            }
            return forkSession(ctx, {
                sessionId: requireString(payload, 'sessionId', 'session.fork'),
                atSeq,
            });
        },
        /**
         * Send a prompt. The client should reuse one `requestId` across retries:
         * the host treats it as an idempotency key and will not insert the same
         * message twice.
         *
         * `text` is required only when there are no attachments. The ids name
         * finished uploads from `upload.finish`; each is checked against this
         * connection's device and this session before anything is read.
         */
        'session.prompt': async (payload, context) => {
            const sessionId = requireString(payload, 'sessionId', 'session.prompt');
            const text = readPromptText(payload);
            const attachmentIds = readAttachmentIds(payload);
            const mode = readMode(payload);
            if (text === undefined && attachmentIds.length === 0) {
                throw new MethodError('MALFORMED_FRAME', 'session.prompt: payload."text" must be a non-empty string when no attachments are given');
            }
            const requestId = optionalString(payload, 'requestId');
            if (attachmentIds.length > 0 && requestId !== undefined) {
                replayGuard.check(context.deviceId, sessionId, requestId, {
                    text,
                    mode,
                    clientTimeZone: optionalString(payload, 'clientTimeZone'),
                    attachmentIds,
                });
            }
            const attachments = attachmentIds.length === 0
                ? []
                : await uploadStore.resolveForPrompt(context.deviceId, sessionId, attachmentIds);
            return promptSession(ctx, {
                sessionId,
                ...(text === undefined ? {} : { text }),
                ...(attachments.length === 0 ? {} : { attachments }),
                mode,
                requestId,
                clientTimeZone: optionalString(payload, 'clientTimeZone'),
            });
        },
        /**
         * Start an attachment upload.
         *
         * The device comes from the connection, not the payload: an upload is one
         * phone's, and no field it sends may say otherwise. `chunkBytes` in the
         * answer is the exact size every chunk but the last must be.
         */
        'upload.begin': async (payload, context) => uploadStore.begin(context.deviceId, parseUploadBegin(payload)),
        /**
         * Send one chunk of an attachment.
         *
         * Idempotent for an index already accepted; refused out of order and when
         * the bytes for an accepted index differ. See `bridge/uploads.ts`.
         */
        'upload.chunk': async (payload, context) => uploadStore.chunk(context.deviceId, parseUploadChunk(payload)),
        /** Finish an upload and get the attachment id a prompt refers to. */
        'upload.finish': async (payload, context) => uploadStore.finish(context.deviceId, requireString(payload, 'uploadId', 'upload.finish')),
        /** Discard a half-sent upload and its bytes. */
        'upload.abort': async (payload, context) => uploadStore.abort(context.deviceId, requireString(payload, 'uploadId', 'upload.abort')),
        /**
         * The attachment limits as this host enforces them.
         *
         * Additive and optional: a client may hardcode the documented numbers and
         * never call this, but one that asks first survives a host that tunes
         * them. Ported from XEPX2's PR #2.
         */
        'upload.capabilities': async () => uploadStore.capabilities(),
        /** Interrupt the running turn. */
        'session.cancel': async (payload) => cancelSession(ctx, requireString(payload, 'sessionId', 'session.cancel')),
        /** Rename a session. */
        'session.rename': async (payload) => {
            await renameSession(ctx, requireString(payload, 'sessionId', 'session.rename'), requireString(payload, 'title', 'session.rename'));
            return { renamed: true };
        },
        /**
         * Archive a session, so it leaves every list -- here and on the computer.
         *
         * Non-destructive: the log stays and so does the session's workspace slot;
         * the registry-global archive set is what the list methods filter on. A
         * running session is refused unless `stopActivity` says the caller means to
         * stop it, which is the behaviour the phone's long-press gesture relies on.
         *
         * A composition whose registry cannot archive answers with an error rather
         * than a success: `{archived: true}` is a claim about the computer, and the
         * next refresh would contradict it.
         */
        'session.archive': async (payload) => {
            const stopActivity = readStopActivity(payload);
            await archiveSession(ctx, {
                sessionId: requireString(payload, 'sessionId', 'session.archive'),
                stopActivity,
            });
            return { archived: true };
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
         * The optional `liveActivityToken` is the one field that is *cleared* by
         * absence. The app sends it while a Live Activity is on screen and omits it
         * afterwards, so a registration without it is the signal that the countdown
         * is gone and the stored token must go with it.
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
                    liveActivityToken: registration.liveActivityToken,
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
