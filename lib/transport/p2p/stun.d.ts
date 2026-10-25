/**
 * The one question a STUN server can answer: what do I look like from the
 * outside?
 *
 * A punch needs the *server-reflexive* address — the public ip:port the NAT
 * maps this socket to — because that is what the far peer has to send to.
 * RFC 5389's Binding transaction is the whole protocol for asking: a 20-byte
 * request with a random transaction id, and a response carrying
 * XOR-MAPPED-ADDRESS.
 *
 * Only the parts a punch client needs, exactly as the Swift side implements
 * them: no SOFTWARE, no FINGERPRINT, no realm/authenticator. Unknown
 * attributes are skipped by length, the way the RFC requires — which is what
 * lets this talk to coturn, to a home router and to the iOS kernel's own fake
 * responder without special cases.
 *
 * @module dsh-mizar/transport/p2p/stun
 */
/** The magic cookie every STUN message carries after its type. */
export declare const MAGIC_COOKIE = 554869826;
/** The fixed header: type, length, cookie, transaction id. */
export declare const STUN_HEADER_LENGTH = 20;
/** Binding Request. */
export declare const BINDING_REQUEST_TYPE = 1;
/** Binding Success Response. */
export declare const BINDING_SUCCESS_RESPONSE_TYPE = 257;
/** MAPPED-ADDRESS — the pre-XOR form, still answered by old servers. */
export declare const MAPPED_ADDRESS_ATTRIBUTE = 1;
/** XOR-MAPPED-ADDRESS — the form everything modern answers with. */
export declare const XOR_MAPPED_ADDRESS_ATTRIBUTE = 32;
/** What the server thinks this socket looks like. */
export interface MappedAddress {
    readonly ip: string;
    readonly port: number;
}
/**
 * A fresh 12-byte transaction id.
 * @returns the id.
 */
export declare function randomTransactionId(): Buffer;
/**
 * Whether a datagram is a STUN message.
 *
 * The first two bits of a STUN message are zero, and the magic cookie sits at
 * offset four. Checking both is what lets the engine tell a STUN answer from
 * a punch packet on the same socket.
 *
 * @param data - the datagram.
 * @returns whether it looks like STUN.
 */
export declare function looksLikeSTUN(data: Buffer): boolean;
/**
 * The transaction id of a message.
 * @param data - a datagram that looks like STUN.
 * @returns the 12-byte id.
 */
export declare function transactionId(data: Buffer): Buffer;
/**
 * Build a Binding Request.
 * @param id - the transaction id to use.
 * @returns the 20-byte request.
 */
export declare function bindingRequest(id: Buffer): Buffer;
/**
 * Parse a Binding Success Response.
 * @param data - the datagram.
 * @param expectedTransactionId - the id the request carried. A response for a
 *   different transaction is somebody else's answer.
 * @returns the mapped address, or `null` when this is not a usable answer.
 */
export declare function parseBindingResponse(data: Buffer, expectedTransactionId: Buffer): MappedAddress | null;
