/** Display-safe DeepSeek official wallet access. Credentials never cross Mizar. */
import type { Context } from '../dsh.js';
interface Wallet {
    readonly currency: 'CNY' | 'USD';
    readonly balance: string;
}
export type BalanceResult = {
    readonly status: 'unsupported' | 'signed-out' | 'unavailable';
} | {
    readonly status: 'ready';
    readonly wallets: readonly Wallet[];
    readonly bonusWallets: readonly Wallet[];
    readonly topUpURL: string;
};
/** A configurable Platform deployment is not necessarily the official service. */
export declare function isOfficialTopUpURL(value: unknown): boolean;
/** Query only native account endpoints, never the API-key REST balance endpoint. */
export declare function accountBalance(ctx: Context, payload: unknown): Promise<BalanceResult>;
export {};
