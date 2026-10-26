/**
 * Getting a notification off this machine.
 *
 * The plugin does not talk to Apple. It cannot: sending a push needs the
 * operator's APNs signing key, and a key that ships inside a plugin installed
 * from a public registry is not a key, it is a public string. So the key lives
 * on the relay, which already has one job -- being the address a phone can
 * always reach -- and the plugin's part is to tell it what happened.
 *
 * That is also why this file is a **transport** and not a policy. Deciding what
 * is worth waking somebody for belongs to {@link PushNotifier}; all that lives
 * here is how to say it out loud, and how to fail quietly when the relay is not
 * there.
 *
 * @module dsh-mizar/push/transport
 */
/** What a notification is about. */
export type PushKind = 'approval' | 'question' | 'turn-complete';
/** Which push service a device's token belongs to. */
export type PushPlatform = 'ios' | 'android';
/** One device's push endpoint, as the phone reported it. */
export interface PushRegistration {
    /** The paired device this token belongs to. */
    readonly deviceId: string;
    /**
     * The device token, as the phone's platform gave it.
     *
     * Hex for iOS, and not remotely hex for Android -- which is why the platform
     * travels with it rather than being guessed from the token's shape.
     */
    readonly token: string;
    /** Which service this token belongs to, and therefore where it is sent. */
    readonly platform: PushPlatform;
    /**
     * Which APNs environment the token was issued for. They are not
     * interchangeable.
     *
     * `null` on Android, where there is one service rather than two, and the
     * question does not arise.
     */
    readonly environment: 'sandbox' | 'production' | null;
    /**
     * The language the notification should be written in.
     *
     * Carried to the relay even though the relay does not use it: the relay shows
     * the registration to an operator diagnosing "why is this phone silent", and a
     * row that says which language it asked for is one less thing to guess.
     */
    readonly locale: string;
    /**
     * The APNs token of the Live Activity currently on screen, when there is one.
     *
     * Omitted when no activity is up. The relay keeps it so it can end the
     * activity from the computer side, which is the case the app cannot cover: a turn
     * that finishes while the app is suspended has nobody on the phone to end the
     * countdown. An older relay ignores the field, exactly as it ignores any other
     * JSON key it does not know.
     */
    readonly liveActivityToken?: string;
    /**
     * The APNs token that can start a Live Activity on this device.
     *
     * A third token, and the only one that can bring a card into existence while
     * the app is not running. It belongs to the install rather than to a card, so
     * omitting it says nothing about whether one is up.
     */
    readonly liveActivityStartToken?: string;
}
/** One row of the Live Activity, as this computer knows it. */
export interface ActivityRow {
    /** The session the row is about. */
    readonly sessionId: string;
    /**
     * What the row says: the host's title for the session.
     *
     * The app falls back to the operator's instruction when there is no title, a
     * field this plugin deliberately does not have -- instructions live in the
     * conversation log, and reading one would be a second source for words the
     * title already covers.
     */
    readonly title: string;
    /** When the work this row counts began, in epoch milliseconds. */
    readonly runningSince: number;
}
/** A Live Activity to start or bring up to date. */
export interface ActivityMessage {
    /**
     * `start` asks the phone to create a card; `update` asks it to change one it
     * already has.
     *
     * The difference is not cosmetic: a start goes to the token that can create an
     * activity, an update to the token that addresses an existing one, and the
     * relay addresses whichever it holds.
     */
    readonly phase: 'start' | 'update';
    /** The rows, oldest first, at most two. */
    readonly rows: readonly ActivityRow[];
    /**
     * Devices whose app is on screen, and which therefore started their own card.
     *
     * A start sent to one is a second card on the same phone, so the plugin names
     * them rather than the relay guessing.
     */
    readonly exceptDeviceIds: readonly string[];
}
/** One notification. */
export interface PushMessage {
    readonly kind: PushKind;
    /** Already localized by the notifier. */
    readonly title: string;
    readonly body: string;
    /** The session it is about, so a tap can open the conversation. */
    readonly sessionId: string | null;
    /** What the phone groups notifications under. One thread per session. */
    readonly threadId: string;
    /** Replaces an earlier notification about the same thing. */
    readonly collapseId: string;
    /**
     * Whether this should break through a Focus mode.
     *
     * An agent stalled on a permission prompt is not doing anything else, and a
     * silent notification about it is a notification that arrives after the
     * operator has stopped caring.
     */
    readonly timeSensitive: boolean;
    /**
     * Devices that must not receive this, because their app is already on screen.
     *
     * The exclusion travels with the message rather than being applied before it
     * leaves: the notifier knows which device is looking, but only the relay knows
     * which tokens are still registered, and the alternative -- unregistering a
     * device every time its app comes forward -- would throw away the token that
     * has to be there when the app goes away again.
     */
    readonly exceptDeviceIds: readonly string[];
    /**
     * Whether the relay should end the Live Activity alongside this notification.
     *
     * Only ever set on a `turn-complete` message, and only when the session that
     * finished was the last one the phone would show still running: an end push
     * tears the countdown down, so sending it while other work is still going
     * would take away the screen the operator is waiting on.
     *
     * Omitted when false, rather than sent as `false`: an older relay then reads
     * the body it always did. Only the relay can act on it, so this is a request,
     * not a promise -- the phones that are asleep are exactly why it exists.
     */
    readonly endLiveActivity?: boolean;
}
/** Where notifications go. */
export interface PushTransport {
    /**
     * Record a device's push endpoint.
     *
     * The answer is the point: a relay older than this plugin answers 404, and a
     * relay that refused a token is a phone that will never be woken. Reporting
     * "registered" either way is how the operator ends up debugging notifications
     * that were never going to arrive.
     *
     * @param registration - the device and its token.
     * @returns whether the relay accepted it.
     */
    register(registration: PushRegistration): Promise<boolean>;
    /**
     * Forget a device's push endpoint.
     * @param deviceId - the device to forget.
     */
    unregister(deviceId: string): Promise<void>;
    /**
     * Deliver one notification to every registered device.
     * @param message - what to send.
     * @returns how many devices the relay accepted it for.
     */
    send(message: PushMessage): Promise<number>;
    /**
     * Start a Live Activity on the phones that do not have one, or update the one
     * they have.
     *
     * Separate from {@link send} because it is not a notification: it carries the
     * rows a card draws rather than words a banner shows, and it is addressed to a
     * different token under a different APNs topic.
     *
     * @param message - the rows and which phase they are in.
     * @returns how many devices the relay accepted it for.
     */
    activity(message: ActivityMessage): Promise<number>;
}
/** A transport that drops everything. The default when no relay is configured. */
export declare class NoopTransport implements PushTransport {
    register(): Promise<boolean>;
    unregister(): Promise<void>;
    send(): Promise<number>;
    activity(): Promise<number>;
}
/** How the relay transport is configured. */
export interface RelayTransportOptions {
    /** The relay's HTTP base, without a trailing slash. */
    readonly baseURL: string;
    /**
     * The credential the relay derives this computer's room from.
     *
     * The same secret the tunnel presents, and deliberately so: the relay already
     * proves it with every tunnel upgrade, so push needs no second enrolment
     * mechanism and no way for a third party to register a token against somebody
     * else's room.
     */
    readonly token: string;
    /** How long one request may take, in milliseconds. */
    readonly timeoutMs?: number;
    /** Where to report. */
    readonly log: (message: string) => void;
}
/**
 * The relay's push API.
 *
 * Every call is best-effort. A notification is an announcement about state that
 * is already durable, so a relay that is down must not fail the approval it was
 * announcing -- and it must not throw into a Cordis event handler, where an
 * exception is the plugin's problem rather than the caller's.
 */
export declare class RelayTransport implements PushTransport {
    #private;
    constructor(options: RelayTransportOptions);
    register(registration: PushRegistration): Promise<boolean>;
    unregister(deviceId: string): Promise<void>;
    activity(message: ActivityMessage): Promise<number>;
    send(message: PushMessage): Promise<number>;
}
