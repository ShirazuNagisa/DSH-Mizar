/**
 * What is worth waking somebody for.
 *
 * Three things, and the list is deliberately short. A notification that arrives
 * for everything is one nobody reads, and the cost of getting this wrong is not
 * an annoyance -- it is that the notification which mattered gets swiped away
 * with the rest.
 *
 *   1. **An agent is blocked on a permission prompt.** Nothing else can happen
 *      until somebody answers, so this is the one case that is genuinely urgent.
 *   2. **An agent is blocked on a question.** The same, one step softer.
 *   3. **A session stopped working.** The answer to "has it finished", which is
 *      the question a phone is opened to ask.
 *
 * ### Why the third one waits
 *
 * DSH does not emit one turn per instruction. Measured on a real session, the
 * log holds long runs of consecutive `turn/start` with no `user/message` between
 * them -- the agent kept working after the turn that answered the prompt ended.
 * Announcing every `turn/end` would send three notifications for one instruction
 * and teach the operator to ignore all of them. So a turn ending only *arms* a
 * timer, and the notification goes out when the session has been quiet for
 * {@link DEFAULT_SETTLE_MS}. Silence is the evidence that the agent is finished.
 *
 * ### Why a foreground app suppresses, per device
 *
 * Pushing a notification about a screen the operator is already looking at is
 * noise with a system banner around it. The app reports whether it is on screen
 * with every registration, and a notification is not sent to a device whose app
 * is.
 *
 * That last word is the whole of the design. An earlier version treated "someone,
 * somewhere, is looking" as a reason to send nothing at all, which sounds the
 * same and is not: an iPad left open on a session silenced the pocketed iPhone,
 * and because the flag was a single boolean that only the device itself could
 * clear, a phone revoked while its app was foreground silenced every
 * notification for this Mac for the life of the process. Excluding the devices
 * that are looking costs one list on the message and makes a stale flag
 * harmless: it can only ever name the device whose app is open, which is the
 * device that does not need the notification anyway.
 *
 * @module dsh-mizar/push/notifier
 */
import type { QuestionItem } from '../bridge/interactions.js';
import type { PushRegistration, PushTransport } from './transport.js';
/** How long a session must be quiet before its turn counts as finished. */
export declare const DEFAULT_SETTLE_MS = 15000;
/** What the notifier needs from the rest of the plugin. */
export interface PushNotifierOptions {
    /** Where notifications go. */
    readonly transport: PushTransport;
    /**
     * How to name a session in a notification.
     *
     * Injected rather than imported because it costs a gateway read, and the
     * notifier must not be the thing that decides when DSH is asked anything.
     */
    readonly describeSession: (sessionId: string) => Promise<string | null>;
    /** The language to write in, read at send time so a change takes effect. */
    readonly locale: () => string;
    /** Where to report. */
    readonly log: (message: string) => void;
    /** How long a session must be quiet, in milliseconds. */
    readonly settleMs?: number;
    /**
     * Whether any session the phone would show is still working.
     *
     * Asked only when a `turn-complete` notification is about to go out, to decide
     * whether the relay should end the Live Activity with it. A Live Activity is
     * the countdown for the work on screen, so while another visible session is
     * still running ending it would take away the wrong screen.
     *
     * Absent when the host cannot answer, and then nothing is ever ended: a
     * countdown that lingers is wrong, but one that disappears under a running
     * session is wrong and loses the screen the operator was using.
     */
    readonly anySessionRunning?: () => Promise<boolean>;
}
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
export declare function languageOf(locale: string): 'zh-Hans' | 'en';
/** The words for one notification, in one language. */
interface Wording {
    readonly title: string;
    readonly body: string;
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
export declare function turnWording(reason: string | null, session: string, language: 'zh-Hans' | 'en'): Wording;
/**
 * The policy in front of the transport.
 *
 * Holds no I/O of its own: every method is a decision, and the transport is
 * where the decision leaves the process.
 */
export declare class PushNotifier {
    #private;
    constructor(options: PushNotifierOptions);
    /**
     * Whether any device's app is on screen.
     *
     * No longer a veto -- see the module comment for why that was wrong -- but
     * still the only way to see the presence bookkeeping from outside, so it stays
     * as the answer to "is this Mac talking to a phone that is awake".
     */
    isForeground(): boolean;
    /**
     * Record what a device's app is doing.
     * @param deviceId - the device.
     * @param foreground - whether its app is on screen.
     */
    setForeground(deviceId: string, foreground: boolean): void;
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
    forget(deviceId: string): void;
    /**
     * Re-register one device's token with the transport.
     * @param registration - the device and its token.
     * @returns whether the transport accepted it.
     */
    register(registration: PushRegistration): Promise<boolean>;
    /**
     * Announce that an agent is blocked on a permission prompt.
     *
     * Not debounced, and not conditional on anything except which devices have
     * their app on screen: an agent waiting for an answer is stopped, and every
     * second spent not knowing is a second of a stalled turn.
     *
     * @param input - the approval, as the answerer narrowed it.
     */
    approvalNeeded(input: {
        sessionId: string | null;
        toolName: string;
        reason?: string;
    }): Promise<void>;
    /**
     * Announce that an agent is blocked on a question.
     * @param input - the question batch.
     */
    questionAsked(input: {
        sessionId: string | null;
        callId: string;
        questions: readonly QuestionItem[];
    }): Promise<void>;
    /**
     * Note that a turn ended, and start the quiet period.
     *
     * @param sessionId - the session.
     * @param reason - `turn/end.reason.kind`, as recorded.
     */
    turnEnded(sessionId: string, reason: string | null): void;
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
    noteActivity(sessionId: string, recordType: string): void;
    /** How many announcements are waiting out their quiet period. */
    get settlingCount(): number;
    /** Drop every pending announcement, for plugin unload. */
    dispose(): void;
}
export {};
