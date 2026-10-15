//
//  CredentialStore.swift
//  MizarKit
//
//  Where the device token lives.
//
//  The token is the long-lived credential that grants remote control of an agent
//  that can execute code on the host, so it goes in the Keychain with
//  `AfterFirstUnlockThisDeviceOnly`: readable by a background reconnect after a
//  reboot, never copied to another device by a backup or iCloud sync.
//
//  The store is a protocol because the Keychain is unavailable in unit tests —
//  and, on a Mac, reaching for it can prompt. Tests inject an in-memory store;
//  nothing else about the client changes.
//

import Foundation
#if canImport(Security)
import Security
#endif

/// A host this device is paired with.
public struct PairedHost: Codable, Sendable, Equatable {
    /// Stable host identity, as reported at pairing.
    public let hostId: String
    /// The host's display name, as the host reports it.
    public let hostName: String
    /// What the operator called this machine on this phone.
    ///
    /// Phone-local and never sent. Someone with three Macs does not want to
    /// distinguish them by `Shirazus-Mac-mini.local` and two UUIDs, and a name
    /// they typed is theirs to change without touching the host.
    public let label: String?
    /// `host:port` the device dials directly, or `nil` when it has none.
    public let authority: String?
    /// Base URL of a reverse tunnel, when the host is behind one.
    public let baseURL: String?
    /// The device id the token belongs to.
    public let deviceId: String
    /// The secret itself.
    public let deviceToken: String
    /// When pairing completed.
    public let pairedAt: Date

    public init(
        hostId: String,
        hostName: String,
        authority: String?,
        deviceId: String,
        deviceToken: String,
        pairedAt: Date = Date(),
        baseURL: String? = nil,
        label: String? = nil,
    ) {
        self.hostId = hostId
        self.hostName = hostName
        self.authority = authority
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.pairedAt = pairedAt
        self.baseURL = baseURL
        self.label = label
    }

    /// What to show for this machine: the operator's name for it, else the
    /// host's own.
    public var displayName: String {
        if let label, !label.trimmingCharacters(in: .whitespaces).isEmpty { return label }
        return hostName
    }

    /// A copy with a new operator-chosen name, keeping the credential.
    ///
    /// - Parameter label: the name to show, or `nil` to go back to the host's.
    /// - Returns: the updated record.
    public func renamed(to label: String?) -> PairedHost {
        PairedHost(
            hostId: hostId,
            hostName: hostName,
            authority: authority,
            deviceId: deviceId,
            deviceToken: deviceToken,
            pairedAt: pairedAt,
            baseURL: baseURL,
            label: label,
        )
    }

    /// Where this host can be reached, in the order worth trying.
    ///
    /// The direct address comes first when there is one: it is the same network
    /// or the same tailnet, so it is faster and involves nobody else. The relay
    /// is the fallback, and for a host whose network blocks inbound traffic it
    /// is the only one that works.
    public var endpoints: [Endpoint] {
        var out: [Endpoint] = []
        if let authority, !authority.isEmpty { out.append(.direct(authority: authority)) }
        if let baseURL, !baseURL.isEmpty, PairingURI.isUsableBaseURL(baseURL) {
            out.append(.relay(baseURL: baseURL))
        }
        return out
    }

    /// One way to reach a host.
    public enum Endpoint: Sendable, Equatable {
        /// Straight to `host:port`.
        case direct(authority: String)
        /// Through a reverse tunnel.
        case relay(baseURL: String)
    }

    /// A copy pointing at a different authority, keeping the credential.
    ///
    /// Used when the host's address changes — a tailnet address is stable but a
    /// LAN address is not — so a moved host is a reconnect rather than a
    /// re-pair.
    ///
    /// - Parameter authority: the new `host:port`.
    /// - Returns: the updated record.
    public func moved(to authority: String) -> PairedHost {
        PairedHost(
            hostId: hostId,
            hostName: hostName,
            authority: authority,
            deviceId: deviceId,
            deviceToken: deviceToken,
            pairedAt: pairedAt,
            baseURL: baseURL,
        )
    }

    /// A copy pointing at a different relay, keeping the credential.
    ///
    /// - Parameter baseURL: the new relay base URL.
    /// - Returns: the updated record.
    public func moved(toRelay baseURL: String?) -> PairedHost {
        PairedHost(
            hostId: hostId,
            hostName: hostName,
            authority: authority,
            deviceId: deviceId,
            deviceToken: deviceToken,
            pairedAt: pairedAt,
            baseURL: baseURL,
        )
    }
}

/// Storage for the paired-host credentials.
///
/// A list, not a single pairing. One phone managing one Mac was the first
/// version's assumption and it is the wrong one for the product: somebody with a
/// laptop and a desktop should not have to unpair one to reach the other.
public protocol CredentialStore: Sendable {
    /// Every machine this phone is paired with, oldest pairing first.
    /// - Returns: the pairings; empty when this device is not paired at all.
    func loadAll() async throws -> [PairedHost]

    /// Insert or replace one pairing, matched by host id.
    /// - Parameter host: the pairing to store.
    func save(_ host: PairedHost) async throws

    /// Forget one pairing.
    /// - Parameter hostId: the machine to forget.
    func remove(hostId: String) async throws

    /// Forget every pairing.
    func clear() async throws
}

extension CredentialStore {
    /// The most recently paired machine, which is the one to open on launch.
    /// - Returns: the pairing, or `nil` when there is none.
    public func load() async throws -> PairedHost? {
        try await loadAll().max { $0.pairedAt < $1.pairedAt }
    }
}

/// A store that keeps the pairings in memory only.
///
/// For tests, and for previews. Explicitly not a fallback for a failed Keychain
/// write: silently degrading to memory would mean a pairing that appears to work
/// and vanishes on the next launch.
public actor InMemoryCredentialStore: CredentialStore {
    private var hosts: [PairedHost]

    public init(host: PairedHost? = nil) {
        self.hosts = host.map { [$0] } ?? []
    }

    public init(hosts: [PairedHost]) {
        self.hosts = hosts
    }

    public func loadAll() async throws -> [PairedHost] { hosts }

    public func save(_ host: PairedHost) async throws {
        if let index = hosts.firstIndex(where: { $0.hostId == host.hostId }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
    }

    public func remove(hostId: String) async throws {
        hosts.removeAll { $0.hostId == hostId }
    }

    public func clear() async throws { hosts = [] }
}

/// The Keychain-backed store.
///
/// One item holds the whole list. That keeps the migration from the single-host
/// shape to a single decode, and an atomic write, at the cost of rewriting every
/// pairing when one changes -- which happens when somebody pairs a machine or
/// renames one, and never otherwise.
public struct KeychainCredentialStore: CredentialStore {
    /// The Keychain account name.
    private let account: String
    /// The Keychain service name.
    private let service: String

    public init(service: String = "dsh-mizar", account: String = "paired-host") {
        self.service = service
        self.account = account
    }

    #if canImport(Security)
    /// The base query identifying this item.
    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
    #endif

    public func loadAll() async throws -> [PairedHost] {
        #if canImport(Security)
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = item as? Data else {
            throw MizarError(
                code: "KEYCHAIN_READ_FAILED",
                message: "could not read the pairing from the keychain (status \(status))",
            )
        }
        return Self.decode(data)
        #else
        return []
        #endif
    }

    /// Decode the stored blob, accepting the single-pairing shape it used to be.
    ///
    /// The first version stored one `PairedHost` object. Anyone upgrading has one
    /// of those, and refusing to read it would silently unpair them and make them
    /// scan again -- so the old shape is read as a list of one, and rewritten in
    /// the new shape the next time anything is saved.
    ///
    /// - Parameter data: the stored bytes.
    /// - Returns: the pairings.
    private static func decode(_ data: Data) -> [PairedHost] {
        let decoder = JSONDecoder()
        if let list = try? decoder.decode([PairedHost].self, from: data) { return list }
        if let one = try? decoder.decode(PairedHost.self, from: data) { return [one] }
        return []
    }

    public func save(_ host: PairedHost) async throws {
        var hosts = try await loadAll()
        if let index = hosts.firstIndex(where: { $0.hostId == host.hostId }) {
            hosts[index] = host
        } else {
            hosts.append(host)
        }
        try await write(hosts)
    }

    public func remove(hostId: String) async throws {
        let remaining = try await loadAll().filter { $0.hostId != hostId }
        if remaining.isEmpty {
            try await clear()
            return
        }
        try await write(remaining)
    }

    public func clear() async throws {
        #if canImport(Security)
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw MizarError(
                code: "KEYCHAIN_DELETE_FAILED",
                message: "could not remove the pairing from the keychain (status \(status))",
            )
        }
        #endif
    }

    /// Store the whole list, replacing whatever was there.
    ///
    /// Update first, then add: `SecItemAdd` fails with `errSecDuplicateItem` when
    /// an item already exists, and deleting-then-adding would open a window where
    /// the credential does not exist -- which on a phone that reconnects in the
    /// background is a window something will fall through.
    ///
    /// - Parameter hosts: the pairings to store.
    private func write(_ hosts: [PairedHost]) async throws {
        #if canImport(Security)
        let data = try JSONEncoder().encode(hosts)

        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            [kSecValueData as String: data] as CFDictionary,
        )
        if updateStatus == errSecSuccess { return }

        var query = baseQuery
        query[kSecValueData as String] = data
        // Readable after the first unlock so a reconnect can happen in the
        // background, but never migrated to another device.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw MizarError(
                code: "KEYCHAIN_WRITE_FAILED",
                message: "could not store the pairing in the keychain (status \(addStatus))",
            )
        }
        #else
        _ = hosts
        throw MizarError(
            code: "KEYCHAIN_UNAVAILABLE",
            message: "no keychain on this platform",
        )
        #endif
    }
}
