/** How long a session must be quiet before its turn counts as finished. */
export const DEFAULT_SETTLE_MS = 15_000;
/** How much of a session title or question a notification carries. */
const MAX_TEXT = 140;
/**
 * Record types that mean the session is working again.
 *
 * The list is an allowlist and not a denylist, because the log carries far more
 * bookkeeping than work: a title written by the title model, a rename from the
 * desktop GUI, a todo snapshot, a context request. Any of those landing inside
 * the quiet window used to cancel the pending "task finished" announcement, so
 * the notification an operator was waiting for was swallowed by a record the
 * agent did not write. A type that arrives from a newer DSH and is not in this
 * list leaves the pending announcement alone, which is the failure worth having:
 * a notification that is a few seconds late beats one that never comes.
 */
const WORKING_RECORDS = new Set([
    'turn/start',
    'step/start',
    'assistant/attempt',
    'assistant/message',
    'user/message',
    'step/end',
]);
/**
 * Which language to write a notification in.
 *
 * The rule the panel uses: Simplified Chinese only where it is unambiguous.
 * Traditional Chinese is written by people who read English far more often than
 * they read Simplified, so `zh-Hant`, `zh-TW`, `zh-HK` and `zh-MO` all get
 * English rather than the wrong Chinese.
 *
 * @param locale - a BCP-47 tag, or anything the phone sent.
 * @returns the language to use.
 */
export function languageOf(locale) {
    const lower = locale.toLowerCase();
    if (!lower.startsWith('zh'))
        return 'en';
    return /hant|tw|hk|mo/.test(lower) ? 'en' : 'zh-Hans';
}
/** Trim a string to something a notification can show. */
function shorten(text) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length <= MAX_TEXT ? collapsed : `${collapsed.slice(0, MAX_TEXT - 1)}…`;
}
/**
 * Write the notification for a turn that finished.
 *
 * The reason is carried through rather than flattened to "done": a turn that
 * ended in `error` did not finish, and telling the operator it did would be a
 * notification that is worse than none.
 *
 * @param reason - `turn/end.reason.kind`, as recorded.
 * @param session - what to call the session.
 * @param language - the language to write in.
 * @returns the title and body.
 */
export function turnWording(reason, session, language) {
    const kind = reason === null ? 'settled' : reason === 'completed' ? 'done' : reason === 'error' ? 'failed' : 'stopped';
    if (language === 'zh-Hans') {
        const title = kind === 'done' ? '任务完成' : kind === 'failed' ? '任务出错' : kind === 'stopped' ? '任务已停止' : '任务已结束';
        return { title, body: session };
    }
    const title = kind === 'done' ? 'Task complete' : kind === 'failed' ? 'Task failed' : kind === 'stopped' ? 'Task stopped' : 'Task finished';
    return { title, body: session };
}
/**
 * The policy in front of the transport.
 *
 * Holds no I/O of its own: every method is a decision, and the transport is
 * where the decision leaves the process.
 */
export class PushNotifier {
    #options;
    #settleMs;
    /** Devices whose app is on screen. */
    #foreground = new Set();
    /** Sessions that have stopped and are waiting out the quiet period. */
    #settling = new Map();
    /** Whether the one "could not tell whether anything is running" line was logged. */
    #warnedLiveActivity = false;
    constructor(options) {
        this.#options = options;
        this.#settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    }
    /**
     * Whether any device's app is on screen.
     *
     * No longer a veto -- see the module comment for why that was wrong -- but
     * still the only way to see the presence bookkeeping from outside, so it stays
     * as the answer to "is this Mac talking to a phone that is awake".
     */
    isForeground() {
        return this.#foreground.size > 0;
    }
    /**
     * Record what a device's app is doing.
     * @param deviceId - the device.
     * @param foreground - whether its app is on screen.
     */
    setForeground(deviceId, foreground) {
        if (foreground)
            this.#foreground.add(deviceId);
        else
            this.#foreground.delete(deviceId);
    }
    /**
     * Forget a device.
     *
     * Called when a device leaves the roster, by both paths that can remove one.
     * The exclusion list is per device now, so a stale entry cannot silence
     * anybody else -- but a revoked device never reports a `false` again, so
     * without this the set keeps a name for something that no longer exists, for
     * the life of the process, and {@link isForeground} answers a question about a
     * phone that is not there.
     *
     * @param deviceId - the device that went away.
     */
    forget(deviceId) {
        this.#foreground.delete(deviceId);
    }
    /**
     * Re-register one device's token with the transport.
     * @param registration - the device and its token.
     * @returns whether the transport accepted it.
     */
    async register(registration) {
        return this.#options.transport.register(registration);
    }
    /**
     * Announce that an agent is blocked on a permission prompt.
     *
     * Not debounced, and not conditional on anything except which devices have
     * their app on screen: an agent waiting for an answer is stopped, and every
     * second spent not knowing is a second of a stalled turn.
     *
     * @param input - the approval, as the answerer narrowed it.
     */
    async approvalNeeded(input) {
        const session = await this.#describe(input.sessionId);
        const language = languageOf(this.#options.locale());
        const detail = input.reason ?? input.toolName;
        await this.#send({
            kind: 'approval',
            title: language === 'zh-Hans' ? '需要你的许可' : 'Permission needed',
            body: shorten(`${detail} · ${session}`),
            sessionId: input.sessionId,
            threadId: input.sessionId ?? 'mizar',
            collapseId: `approval-${input.sessionId ?? 'mizar'}-${input.toolName}`,
            timeSensitive: true,
        });
    }
    /**
     * Announce that an agent is blocked on a question.
     * @param input - the question batch.
     */
    async questionAsked(input) {
        const session = await this.#describe(input.sessionId);
        const language = languageOf(this.#options.locale());
        const first = input.questions[0];
        const asked = first?.question ?? '';
        await this.#send({
            kind: 'question',
            title: language === 'zh-Hans' ? '模型有问题要问你' : 'The model has a question',
            body: shorten(asked === '' ? session : `${asked} · ${session}`),
            sessionId: input.sessionId,
            threadId: input.sessionId ?? 'mizar',
            collapseId: `question-${input.callId}`,
            timeSensitive: true,
        });
    }
    /**
     * Note that a turn ended, and start the quiet period.
     *
     * @param sessionId - the session.
     * @param reason - `turn/end.reason.kind`, as recorded.
     */
    turnEnded(sessionId, reason) {
        this.#cancel(sessionId);
        const timer = setTimeout(() => {
            this.#settling.delete(sessionId);
            void this.#announceSettled(sessionId, reason);
        }, this.#settleMs);
        // A pending notification must not be the reason the process stays alive.
        timer.unref?.();
        this.#settling.set(sessionId, { timer, reason });
    }
    /**
     * Note that a session did something, and cancel the announcement if it counts.
     *
     * The record type is required rather than optional so that a caller cannot
     * cancel an announcement by passing everything through: the decision belongs
     * here, with the other policy, and a caller that has not thought about what
     * the record means is asked to.
     *
     * @param sessionId - the session that moved.
     * @param recordType - the session-log record that moved it.
     */
    noteActivity(sessionId, recordType) {
        if (!WORKING_RECORDS.has(recordType))
            return;
        this.#cancel(sessionId);
    }
    /** How many announcements are waiting out their quiet period. */
    get settlingCount() {
        return this.#settling.size;
    }
    /** Drop every pending announcement, for plugin unload. */
    dispose() {
        for (const entry of this.#settling.values())
            clearTimeout(entry.timer);
        this.#settling.clear();
        this.#foreground.clear();
    }
    /** Cancel a session's pending announcement. */
    #cancel(sessionId) {
        const entry = this.#settling.get(sessionId);
        if (entry === undefined)
            return;
        clearTimeout(entry.timer);
        this.#settling.delete(sessionId);
    }
    /** Send the announcement for a session that has stopped. */
    async #announceSettled(sessionId, reason) {
        const session = await this.#describe(sessionId);
        const wording = turnWording(reason, session, languageOf(this.#options.locale()));
        // Only a turn that finished can be the end of the work, and only when
        // nothing the phone would show is still going. The app ends its own Live
        // Activity while it is running; this is that same end for the case the app
        // cannot cover -- one that arrives while the phone is suspended.
        const endLiveActivity = await this.#nothingIsRunning();
        await this.#send({
            kind: 'turn-complete',
            title: wording.title,
            body: shorten(wording.body),
            sessionId,
            threadId: sessionId,
            // Keyed on the session, so a second finish after a continuation replaces
            // the first rather than stacking under it.
            collapseId: `turn-${sessionId}`,
            timeSensitive: false,
            ...(endLiveActivity ? { endLiveActivity: true } : {}),
        });
    }
    /**
     * Whether it is safe to ask the relay to end the Live Activity.
     *
     * Defaults to `false` everywhere it cannot tell: no callback, or a callback
     * that failed. Ending the countdown on a guess would remove the screen a
     * still-running session owns, which is the one failure the feature must not
     * have -- leaving it up is only a stale clock.
     */
    async #nothingIsRunning() {
        const check = this.#options.anySessionRunning;
        if (check === undefined)
            return false;
        try {
            return (await check()) === false;
        }
        catch (error) {
            // Once, not once per announcement: a gateway that is down would otherwise
            // write a line for every session that finishes for as long as it is down.
            if (!this.#warnedLiveActivity) {
                this.#warnedLiveActivity = true;
                const detail = error instanceof Error ? error.message : String(error);
                this.#options.log(`push: could not tell whether any session is running — leaving the live activity up (${detail})`);
            }
            return false;
        }
    }
    /** Name a session, tolerating a host that will not say. */
    async #describe(sessionId) {
        // Through `languageOf`, not a `startsWith('zh')` of its own: a Traditional
        // Chinese phone gets English everywhere else, and one Chinese noun in the
        // middle of an English sentence is worse than either language alone.
        if (sessionId === null)
            return languageOf(this.#options.locale()) === 'zh-Hans' ? '某个会话' : 'a session';
        try {
            const title = await this.#options.describeSession(sessionId);
            if (title !== null && title !== '')
                return title;
        }
        catch {
            // A notification is not worth failing over a lookup.
        }
        return sessionId;
    }
    /**
     * Hand one message to the transport, with the devices that are looking
     * excluded.
     *
     * The parameter is the message *without* the exclusion list: only this class
     * holds the presence bookkeeping, so a caller that had to fill it in would be
     * a caller that could get it wrong. There is no early return for "somebody is
     * looking" -- an iPhone in a pocket is not covered by an iPad on a desk, and
     * the exclusion list is what keeps the two apart.
     */
    async #send(message) {
        try {
            const sent = await this.#options.transport.send({
                ...message,
                exceptDeviceIds: [...this.#foreground],
            });
            if (sent > 0)
                this.#options.log(`push: ${message.kind} → ${sent} device(s)`);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.#options.log(`push: ${message.kind} could not be sent — ${detail}`);
        }
    }
}
