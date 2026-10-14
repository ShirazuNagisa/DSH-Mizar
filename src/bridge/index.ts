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
import type { Context } from '../dsh.js'
import { deliverQuestionAnswers } from './answerers.js'
import { toMethodError } from './errors.js'
import {
  CLIENT_APPROVAL_OUTCOMES,
  InteractionBroker,
  type ClientApprovalOutcome,
  type QuestionAnswerItem,
} from './interactions.js'
import { MethodError, optionalObject, optionalString, requireString } from './method-error.js'
import { modelCatalog, selectModel } from './models.js'
import { permissionCatalog, setPermissionPreset } from './permissions.js'
import {
  cancelSession,
  createSession,
  listSessions,
  promptSession,
  renameSession,
  sessionMessages,
  sessionStats,
} from './sessions.js'

/** Per-connection facts handed to a method. */
export interface MethodContext {
  /** The authenticated device's id. */
  readonly deviceId: string
  /** The authenticated device's display name. */
  readonly deviceName: string
  /** The remote address the request arrived from. */
  readonly remote: string
}

/** A wire method implementation. */
export type MethodHandler = (payload: unknown, context: MethodContext) => Promise<unknown>

/** What the bridge needs from its host to answer `host.info`. */
export interface HostFacts {
  readonly hostId: string
  readonly hostName: string
  readonly home: string
  readonly protocolVersion: number
}

/**
 * Translate any thrown value into a wire-coded failure.
 * @param handler - the raw implementation.
 * @returns the guarded implementation.
 */
function guard(handler: MethodHandler): MethodHandler {
  return async (payload, context) => {
    try {
      return await handler(payload, context)
    } catch (error) {
      throw toMethodError(error)
    }
  }
}

/**
 * Read the optional delivery mode for a prompt.
 * @param payload - the request payload.
 * @returns the mode, defaulting to `queue`.
 */
function readMode(payload: unknown): 'queue' | 'steer' {
  const mode = optionalString(payload, 'mode')
  if (mode === undefined) return 'queue'
  if (mode !== 'queue' && mode !== 'steer') {
    throw new MethodError('MALFORMED_FRAME', `session.prompt: mode must be "queue" or "steer", got "${mode}"`)
  }
  return mode
}

/**
 * Read a client answer batch for a question.
 * @param payload - the request payload.
 * @returns the batch, already narrowed.
 * @throws MethodError when an item is not `{id, selected}`.
 */
function readAnswerBatch(payload: unknown): QuestionAnswerItem[] {
  const record = optionalObject(payload, 'question.answer')
  const raw = record['answers']
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MethodError('MALFORMED_FRAME', 'question.answer: payload."answers" must be a non-empty array')
  }
  return raw.map((entry): QuestionAnswerItem => {
    if (typeof entry !== 'object' || entry === null) {
      throw new MethodError('MALFORMED_FRAME', 'question.answer: each answer must be an object')
    }
    const item = entry as Record<string, unknown>
    if (typeof item['id'] !== 'string' || item['id'] === '') {
      throw new MethodError('MALFORMED_FRAME', 'question.answer: each answer needs a string "id"')
    }
    const selected = item['selected']
    if (!Array.isArray(selected) || selected.some((value) => typeof value !== 'string')) {
      throw new MethodError(
        'MALFORMED_FRAME',
        `question.answer: answer "${item['id']}" needs "selected" as an array of strings`,
      )
    }
    const custom = item['custom']
    if (custom !== undefined && typeof custom !== 'string') {
      throw new MethodError('MALFORMED_FRAME', `question.answer: answer "${item['id']}" has a non-string "custom"`)
    }
    return {
      id: item['id'],
      selected: selected as string[],
      ...(typeof custom === 'string' ? { custom } : {}),
    }
  })
}

/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients.
 * @param broker - the interaction broker holding pending approvals and questions.
 * @returns the table, keyed by wire method name.
 */
export function createMethodTable(
  ctx: Context,
  facts: HostFacts,
  broker: InteractionBroker,
): Record<string, MethodHandler> {
  const table: Record<string, MethodHandler> = {
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
     * One session's usage frame. Works for a cold session: the projection read
     * does not activate an agent.
     */
    'session.stats': async (payload) =>
      sessionStats(ctx, requireString(payload, 'sessionId', 'session.stats')),
    'session.messages': async (payload) => {
      const limit = (payload as Record<string, unknown> | undefined)?.['maxMessages']
      return sessionMessages(
        ctx,
        requireString(payload, 'sessionId', 'session.messages'),
        typeof limit === 'number' ? limit : undefined,
      )
    },

    /**
     * Create a session, or adopt/resume one when `sessionId` is supplied.
     *
     * Every argument is optional, so the payload is validated for *type* here:
     * a non-object payload must report a mistake, not quietly create a session
     * with defaults.
     */
    'session.create': async (payload) => {
      const args = optionalObject(payload, 'session.create')
      return createSession(ctx, {
        workspaceId: optionalString(args, 'workspaceId'),
        cwd: optionalString(args, 'cwd'),
        sessionId: optionalString(args, 'sessionId'),
        agentPreset: optionalString(args, 'agentPreset'),
      })
    },

    /**
     * Send a prompt. The client should reuse one `requestId` across retries:
     * the host treats it as an idempotency key and will not insert the same
     * message twice.
     */
    'session.prompt': async (payload) =>
      promptSession(ctx, {
        sessionId: requireString(payload, 'sessionId', 'session.prompt'),
        text: requireString(payload, 'text', 'session.prompt'),
        mode: readMode(payload),
        requestId: optionalString(payload, 'requestId'),
        clientTimeZone: optionalString(payload, 'clientTimeZone'),
      }),

    /** Interrupt the running turn. */
    'session.cancel': async (payload) =>
      cancelSession(ctx, requireString(payload, 'sessionId', 'session.cancel')),

    /** Rename a session. */
    'session.rename': async (payload) => {
      await renameSession(
        ctx,
        requireString(payload, 'sessionId', 'session.rename'),
        requireString(payload, 'title', 'session.rename'),
      )
      return { renamed: true }
    },

    /** The model catalog the picker renders, with each model's reasoning levels. */
    'model.catalog': async () => modelCatalog(ctx),

    /** Select the model and reasoning effort for one session. */
    'session.model.set': async (payload) => {
      const effort = optionalString(payload, 'reasoningEffort')
      return selectModel(ctx, {
        sessionId: requireString(payload, 'sessionId', 'session.model.set'),
        provider: requireString(payload, 'provider', 'session.model.set'),
        model: requireString(payload, 'model', 'session.model.set'),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      })
    },

    /** The permission presets this host currently offers. */
    'permissions.catalog': async () => permissionCatalog(ctx),

    /** Switch one session's permission preset. */
    'session.permission.set': async (payload) =>
      setPermissionPreset(ctx, {
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
      const requestId = requireString(payload, 'requestId', 'approval.answer')
      const outcome = requireString(payload, 'outcome', 'approval.answer')
      if (!(CLIENT_APPROVAL_OUTCOMES as readonly string[]).includes(outcome)) {
        throw new MethodError(
          'MALFORMED_FRAME',
          `approval.answer: outcome must be one of ${CLIENT_APPROVAL_OUTCOMES.join(', ')}`,
        )
      }
      return { accepted: broker.answerApproval(requestId, outcome as ClientApprovalOutcome) }
    },

    /**
     * Answer a question batch.
     *
     * Only works while the batch is still pending *here*. A batch the host
     * already timed out is answered through the late path instead, which the
     * question's own projection reports as `continued`.
     */
    'question.answer': async (payload) => {
      const callId = requireString(payload, 'callId', 'question.answer')
      return { accepted: deliverQuestionAnswers(broker, callId, readAnswerBatch(payload)) }
    },
  }

  return Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, guard(handler)]))
}
