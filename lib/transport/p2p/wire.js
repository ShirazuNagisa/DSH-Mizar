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
export const MAGIC = Buffer.from('MZP1', 'utf8');
/** The fixed header length. */
export const HEADER_LENGTH = 15;
/** How many packet numbers one packet may acknowledge. */
export const MAX_ACKS_PER_PACKET = 8;
/**
 * Hard cap on a datagram, punch packets included.
 *
 * 1200 bytes is the smallest IPv4 MTU worth respecting over a tunnel; staying
 * under it means no IP fragmentation on any path this protocol is meant for.
 */
export const MAX_DATAGRAM_BYTES = 1200;
/** What a datagram is. */
export var PacketType;
(function (PacketType) {
    /** The dialler's punch packet: "I am this endpoint, here is my ephemeral key, signed." */
    PacketType[PacketType["ClientHello"] = 1] = "ClientHello";
    /** The acceptor's answer: the same, in the other direction. */
    PacketType[PacketType["ServerHello"] = 2] = "ServerHello";
    /** Sealed payload, with piggybacked acks. */
    PacketType[PacketType["Data"] = 3] = "Data";
    /** An empty packet that keeps a NAT mapping warm. */
    PacketType[PacketType["Keepalive"] = 4] = "Keepalive";
    /** The last word: the sender is gone. */
    PacketType[PacketType["Close"] = 5] = "Close";
    /** A standalone ack, when there is no data to carry it on. */
    PacketType[PacketType["Ack"] = 6] = "Ack";
})(PacketType || (PacketType = {}));
/**
 * Build the fixed header.
 * @param type - the packet type.
 * @param connectionId - the connection the packet belongs to.
 * @param payloadLength - length of everything after the header.
 * @returns the 15-byte header.
 */
export function encodeHeader(type, connectionId, payloadLength) {
    if (payloadLength < 0 || payloadLength > 0xffff) {
        // A payload this size is a bug upstream, not a packet: refusing here keeps
        // a truncated length out of a header the receiver will trust.
        throw new RangeError(`payload length ${payloadLength} does not fit in a header`);
    }
    const header = Buffer.alloc(HEADER_LENGTH);
    MAGIC.copy(header, 0);
    header.writeUInt8(type, 4);
    header.writeBigUInt64BE(connectionId, 5);
    header.writeUInt16BE(payloadLength, 13);
    return header;
}
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
export function parseHeader(data) {
    if (data.length < HEADER_LENGTH)
        return null;
    if (!data.subarray(0, 4).equals(MAGIC))
        return null;
    const rawType = data.readUInt8(4);
    if (rawType < 1 || rawType > 6)
        return null;
    const connectionId = data.readBigUInt64BE(5);
    const payloadLength = data.readUInt16BE(13);
    if (data.length !== HEADER_LENGTH + payloadLength)
        return null;
    return { type: rawType, connectionId, payloadLength };
}
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
export function handshakeMessage(type, connectionId, ephemeralPublicKey, endpointId) {
    const idBytes = Buffer.from(endpointId, 'utf8');
    const message = Buffer.alloc(1 + 8 + ephemeralPublicKey.length + idBytes.length);
    let offset = 0;
    message.writeUInt8(type, offset);
    offset += 1;
    message.writeBigUInt64BE(connectionId, offset);
    offset += 8;
    Buffer.from(ephemeralPublicKey).copy(message, offset);
    offset += ephemeralPublicKey.length;
    idBytes.copy(message, offset);
    return message;
}
/**
 * Build a hello packet.
 * @param type - ClientHello or ServerHello.
 * @param connectionId - the connection the hello opens.
 * @param endpointId - the sender's endpoint id (at most 255 bytes).
 * @param ephemeralPublicKey - the sender's X25519 ephemeral public key.
 * @param signature - the signature over {@link handshakeMessage}.
 * @returns the datagram.
 */
export function encodeHello(type, connectionId, endpointId, ephemeralPublicKey, signature) {
    const idBytes = Buffer.from(endpointId, 'utf8');
    if (idBytes.length === 0 || idBytes.length > 0xff) {
        throw new RangeError(`endpoint id of ${idBytes.length} bytes does not fit a hello`);
    }
    const payload = Buffer.concat([
        Buffer.from(ephemeralPublicKey),
        Buffer.from([idBytes.length]),
        idBytes,
        Buffer.from(signature),
    ]);
    return Buffer.concat([encodeHeader(type, connectionId, payload.length), payload]);
}
/**
 * Parse a hello.
 *
 * The signature is *not* verified here — that is the identity layer's job, and
 * it needs the endpoint id this parser returns.
 *
 * @param data - the whole datagram.
 * @returns the header and handshake, or `null` when this is not a hello.
 */
export function parseHello(data) {
    const header = parseHeader(data);
    if (header === null)
        return null;
    if (header.type !== PacketType.ClientHello && header.type !== PacketType.ServerHello)
        return null;
    const payload = data.subarray(HEADER_LENGTH);
    // 32 ephemeral + 1 length + at least 1 id byte + 64 signature.
    if (payload.length < 32 + 1 + 1 + 64)
        return null;
    const ephemeralPublicKey = payload.subarray(0, 32);
    const idLength = payload.readUInt8(32);
    if (idLength === 0 || payload.length < 33 + idLength + 64)
        return null;
    const endpointId = payload.subarray(33, 33 + idLength).toString('utf8');
    const signature = payload.subarray(33 + idLength, 33 + idLength + 64);
    return {
        header,
        handshake: { endpointId, ephemeralPublicKey: Buffer.from(ephemeralPublicKey), signature: Buffer.from(signature) },
    };
}
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
export function encodeData(connectionId, packetNumber, acks, messageLength, sealed) {
    const carried = acks.slice(0, MAX_ACKS_PER_PACKET);
    const payload = Buffer.alloc(4 + 1 + carried.length * 4 + 4 + sealed.length);
    let offset = 0;
    payload.writeUInt32BE(packetNumber, offset);
    offset += 4;
    payload.writeUInt8(carried.length, offset);
    offset += 1;
    for (const ack of carried) {
        payload.writeUInt32BE(ack, offset);
        offset += 4;
    }
    payload.writeUInt32BE(messageLength, offset);
    offset += 4;
    Buffer.from(sealed).copy(payload, offset);
    return Buffer.concat([encodeHeader(PacketType.Data, connectionId, payload.length), payload]);
}
/**
 * Parse a data packet.
 * @param data - the whole datagram.
 * @returns the packet, or `null` when this is not one.
 */
export function parseData(data) {
    const header = parseHeader(data);
    if (header === null || header.type !== PacketType.Data)
        return null;
    const payload = data.subarray(HEADER_LENGTH);
    if (payload.length < 4 + 1 + 4)
        return null;
    const packetNumber = payload.readUInt32BE(0);
    const ackCount = payload.readUInt8(4);
    const acksEnd = 5 + ackCount * 4;
    if (acksEnd + 4 > payload.length)
        return null;
    const acks = [];
    for (let index = 0; index < ackCount; index += 1) {
        acks.push(payload.readUInt32BE(5 + index * 4));
    }
    const messageLength = payload.readUInt32BE(acksEnd);
    const sealed = payload.subarray(acksEnd + 4);
    // An empty `sealed` cannot even hold a tag: the packet is malformed, not
    // merely empty.
    if (sealed.length === 0)
        return null;
    const authenticatedData = Buffer.concat([
        data.subarray(0, HEADER_LENGTH),
        payload.subarray(0, 4),
        payload.subarray(acksEnd, acksEnd + 4),
    ]);
    return {
        connectionId: header.connectionId,
        packetNumber,
        acks,
        messageLength,
        sealed: Buffer.from(sealed),
        authenticatedData,
    };
}
/**
 * Build a standalone ack.
 * @param connectionId - the connection.
 * @param acks - packet numbers being acknowledged; at most eight are carried.
 * @returns the datagram.
 */
export function encodeAck(connectionId, acks) {
    const carried = acks.slice(0, MAX_ACKS_PER_PACKET);
    const payload = Buffer.alloc(1 + carried.length * 4);
    payload.writeUInt8(carried.length, 0);
    carried.forEach((ack, index) => payload.writeUInt32BE(ack, 1 + index * 4));
    return Buffer.concat([encodeHeader(PacketType.Ack, connectionId, payload.length), payload]);
}
/**
 * Parse a standalone ack.
 * @param data - the whole datagram.
 * @returns the connection id and the acknowledged packet numbers.
 */
export function parseAck(data) {
    const header = parseHeader(data);
    if (header === null || header.type !== PacketType.Ack)
        return null;
    const payload = data.subarray(HEADER_LENGTH);
    if (payload.length < 1)
        return null;
    const ackCount = payload.readUInt8(0);
    if (payload.length < 1 + ackCount * 4)
        return null;
    const acks = [];
    for (let index = 0; index < ackCount; index += 1) {
        acks.push(payload.readUInt32BE(1 + index * 4));
    }
    return { connectionId: header.connectionId, acks };
}
/**
 * Build a keepalive.
 * @param connectionId - the connection to keep warm.
 * @returns the datagram.
 */
export function encodeKeepalive(connectionId) {
    return encodeHeader(PacketType.Keepalive, connectionId, 0);
}
/**
 * Build a close.
 * @param connectionId - the connection being closed.
 * @param reason - a short human-readable reason; truncated to 255 bytes.
 * @returns the datagram.
 */
export function encodeClose(connectionId, reason) {
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 255);
    const payload = Buffer.concat([Buffer.from([reasonBytes.length]), reasonBytes]);
    return Buffer.concat([encodeHeader(PacketType.Close, connectionId, payload.length), payload]);
}
/**
 * Parse a close.
 * @param data - the whole datagram.
 * @returns the connection id and whatever reason the sender could fit.
 */
export function parseClose(data) {
    const header = parseHeader(data);
    if (header === null || header.type !== PacketType.Close)
        return null;
    const payload = data.subarray(HEADER_LENGTH);
    if (payload.length < 1)
        return { connectionId: header.connectionId, reason: '' };
    const length = payload.readUInt8(0);
    if (length === 0 || payload.length < 1 + length)
        return { connectionId: header.connectionId, reason: '' };
    return { connectionId: header.connectionId, reason: payload.subarray(1, 1 + length).toString('utf8') };
}
