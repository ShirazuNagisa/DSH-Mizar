/**
 * The MizarNet wire format, in TypeScript.
 *
 * Six packet types, one 15-byte header, all big-endian:
 *
 *     magic "MZP1" | type (1) | connection id (8) | payload length (2)
 *
 * This is a second implementation of `MizarNetPunchPacket.swift`, written
 * against the same fixture rather than against the Swift source, so that the
 * two can be checked against each other (`protocol/fixtures/p2p-wire.json`).
 * A datagram this module builds has to be one the phone accepts without a
 * compatibility flag, and vice versa.
 *
 * The connection id is a 64-bit unsigned integer and is carried as a `bigint`.
 * That is not pedantry: the id is random over the full 64-bit space, and a
 * value above 2^53 cannot survive a JavaScript `number`. Rounding one would
 * produce a packet for a connection that does not exist — and the failure
 * would be a session that never forms, blamed on the network.
 *
 * @module dsh-mizar/transport/p2p/wire
 */
/** The four magic bytes every datagram starts with. */
export declare const MAGIC: Buffer<ArrayBuffer>;
/** The fixed header length. */
export declare const HEADER_LENGTH = 15;
/** How many packet numbers one packet may acknowledge. */
export declare const MAX_ACKS_PER_PACKET = 8;
/**
 * Hard cap on a datagram, punch packets included.
 *
 * 1200 bytes is the smallest IPv4 MTU worth respecting over a tunnel; staying
 * under it means no IP fragmentation on any path this protocol is meant for.
 */
export declare const MAX_DATAGRAM_BYTES = 1200;
/** What a datagram is. */
export declare enum PacketType {
    /** The dialler's punch packet: "I am this endpoint, here is my ephemeral key, signed." */
    ClientHello = 1,
    /** The acceptor's answer: the same, in the other direction. */
    ServerHello = 2,
    /** Sealed payload, with piggybacked acks. */
    Data = 3,
    /** An empty packet that keeps a NAT mapping warm. */
    Keepalive = 4,
    /** The last word: the sender is gone. */
    Close = 5,
    /** A standalone ack, when there is no data to carry it on. */
    Ack = 6
}
/** The fixed header, parsed. */
export interface PacketHeader {
    readonly type: PacketType;
    readonly connectionId: bigint;
    readonly payloadLength: number;
}
/** What a hello carries, whichever direction it travels. */
export interface Handshake {
    /** The sender's endpoint id: the base64url Ed25519 public key. */
    readonly endpointId: string;
    /** The sender's ephemeral X25519 public key, 32 bytes. */
    readonly ephemeralPublicKey: Buffer;
    /** The Ed25519 signature over {@link handshakeMessage}. */
    readonly signature: Buffer;
}
/** A parsed data packet. */
export interface DataPacket {
    readonly connectionId: bigint;
    readonly packetNumber: number;
    /** Packet numbers the sender has delivered, piggybacked here. */
    readonly acks: readonly number[];
    /** The length of the whole message this chunk belongs to. */
    readonly messageLength: number;
    /** The sealed chunk, tag included. */
    readonly sealed: Buffer;
    /**
     * The bytes the AEAD authenticates: header + packet number + message length.
     * Reconstructed here so the opener passes exactly what the sealer passed.
     */
    readonly authenticatedData: Buffer;
}
/**
 * Build the fixed header.
 * @param type - the packet type.
 * @param connectionId - the connection the packet belongs to.
 * @param payloadLength - length of everything after the header.
 * @returns the 15-byte header.
 */
export declare function encodeHeader(type: PacketType, connectionId: bigint, payloadLength: number): Buffer;
/**
 * Parse and validate a header.
 *
 * The length check is exact on purpose: a UDP datagram is one packet, so a
 * header whose length disagrees with the datagram is either corrupt or belongs
 * to something else, and splitting the difference would hand the session a
 * payload with the wrong bounds.
 *
 * @param data - the whole datagram.
 * @returns the header, or `null` when this is not a MizarNet packet.
 */
export declare function parseHeader(data: Buffer): PacketHeader | null;
/**
 * The bytes a hello signs.
 *
 * Type, connection id, ephemeral key, endpoint id — everything that binds the
 * hello to this connection and this identity. The leading type byte is domain
 * separation: a ClientHello can never be replayed as a ServerHello, because
 * the signature would not verify against the other type.
 *
 * @param type - ClientHello or ServerHello.
 * @param connectionId - the connection the hello opens.
 * @param ephemeralPublicKey - the sender's X25519 ephemeral public key.
 * @param endpointId - the sender's endpoint id.
 * @returns the message to sign.
 */
export declare function handshakeMessage(type: PacketType, connectionId: bigint, ephemeralPublicKey: Uint8Array, endpointId: string): Buffer;
/**
 * Build a hello packet.
 * @param type - ClientHello or ServerHello.
 * @param connectionId - the connection the hello opens.
 * @param endpointId - the sender's endpoint id (at most 255 bytes).
 * @param ephemeralPublicKey - the sender's X25519 ephemeral public key.
 * @param signature - the signature over {@link handshakeMessage}.
 * @returns the datagram.
 */
export declare function encodeHello(type: PacketType, connectionId: bigint, endpointId: string, ephemeralPublicKey: Uint8Array, signature: Uint8Array): Buffer;
/**
 * Parse a hello.
 *
 * The signature is *not* verified here — that is the identity layer's job, and
 * it needs the endpoint id this parser returns.
 *
 * @param data - the whole datagram.
 * @returns the header and handshake, or `null` when this is not a hello.
 */
export declare function parseHello(data: Buffer): {
    header: PacketHeader;
    handshake: Handshake;
} | null;
/**
 * Build a data packet.
 *
 * Layout after the header: packet number (4), ack count (1), the acked packet
 * numbers (4 each), message length (4), then the sealed chunk. The message
 * length sits outside the AEAD but inside the authenticated data, so a chunk
 * cannot be re-framed into a different message.
 *
 * @param connectionId - the connection.
 * @param packetNumber - this packet's number, which is also its nonce.
 * @param acks - packet numbers being acknowledged; at most eight are carried.
 * @param messageLength - the length of the whole message this chunk belongs to.
 * @param sealed - the sealed chunk, tag included.
 * @returns the datagram.
 */
export declare function encodeData(connectionId: bigint, packetNumber: number, acks: readonly number[], messageLength: number, sealed: Uint8Array): Buffer;
/**
 * Parse a data packet.
 * @param data - the whole datagram.
 * @returns the packet, or `null` when this is not one.
 */
export declare function parseData(data: Buffer): DataPacket | null;
/**
 * Build a standalone ack.
 * @param connectionId - the connection.
 * @param acks - packet numbers being acknowledged; at most eight are carried.
 * @returns the datagram.
 */
export declare function encodeAck(connectionId: bigint, acks: readonly number[]): Buffer;
/**
 * Parse a standalone ack.
 * @param data - the whole datagram.
 * @returns the connection id and the acknowledged packet numbers.
 */
export declare function parseAck(data: Buffer): {
    connectionId: bigint;
    acks: readonly number[];
} | null;
/**
 * Build a keepalive.
 * @param connectionId - the connection to keep warm.
 * @returns the datagram.
 */
export declare function encodeKeepalive(connectionId: bigint): Buffer;
/**
 * Build a close.
 * @param connectionId - the connection being closed.
 * @param reason - a short human-readable reason; truncated to 255 bytes.
 * @returns the datagram.
 */
export declare function encodeClose(connectionId: bigint, reason: string): Buffer;
/**
 * Parse a close.
 * @param data - the whole datagram.
 * @returns the connection id and whatever reason the sender could fit.
 */
export declare function parseClose(data: Buffer): {
    connectionId: bigint;
    reason: string;
} | null;
