/**
 * The three wire methods that let a phone be notified.
 *
 * Split from the bridge's method table so the table stays a table: every DSH
 * call lives under `bridge/`, and everything that touches the roster or the
 * relay lives here.
 *
 * Three methods rather than one, and the split is not cosmetic. A device
 * registers its token once per launch, tells the host whether its app is on
 * screen every time the operator switches away, and forgets the token when
 * permission is revoked. Folding the second into the first would put an HTTP
 * request to the relay behind every app switch.
 *
 * @module dsh-mizar/push/binding
 */
import type { MizarStore } from '../auth/store.js';
import type { PushNotifier } from './notifier.js';
import type { PushPlatform, PushTransport } from './transport.js';
/** What a client may report about its push endpoint. */
export interface PushRegistrationInput {
    readonly token: string;
    /** Which service the token belongs to. */
    readonly platform: PushPlatform;
    /**
     * Which APNs environment the token was issued for.
     *
     * `null` on Android. The bridge is what enforces that: it reads this field
     * only for iOS, so an Android client neither has to know about it nor can get
     * it wrong.
     */
    readonly environment: 'sandbox' | 'production' | null;
    readonly locale: string;
    /**
     * The APNs push token of the Live Activity on screen, or `null` when none is.
     *
     * `null` clears the stored token rather than leaving it alone: the app omits
     * the field once its activity is gone, and a token kept past that point is a
     * credential for ending a countdown that no longer exists.
     */
    readonly liveActivityToken: string | null;
}
/** What the bridge calls. */
export interface PushBinding {
    /**
     * Record where to reach one device, and tell the relay.
     * @param deviceId - the authenticated device.
     * @param input - its token, platform and environment.
     * @returns whether the device is on the roster.
     */
    register(deviceId: string, input: PushRegistrationInput): Promise<boolean>;
    /**
     * Say whether the app is on screen, without touching the relay.
     * @param deviceId - the authenticated device.
     * @param foreground - whether its app is in the foreground.
     */
    presence(deviceId: string, foreground: boolean): void;
    /**
     * Forget a device's token, here and at the relay.
     * @param deviceId - the authenticated device.
     * @returns whether the device is on the roster.
     */
    unregister(deviceId: string): Promise<boolean>;
    /**
     * Re-announce every stored token to the relay.
     *
     * Called when the tunnel comes back. The relay keeps registrations in memory
     * and loses them when it restarts; the roster is the durable copy, so a
     * reconnect is the moment to hand it over again. Without this a relay restart
     * silently ends push until every phone happens to relaunch.
     */
    republish(): Promise<number>;
}
/** What the binding needs. */
export interface PushBindingOptions {
    readonly store: MizarStore;
    readonly notifier: PushNotifier;
    readonly transport: PushTransport;
    readonly log: (message: string) => void;
}
/**
 * Build the binding.
 * @param options - the roster, the notifier and the relay.
 * @returns the binding the bridge calls.
 */
export declare function createPushBinding(options: PushBindingOptions): PushBinding;
