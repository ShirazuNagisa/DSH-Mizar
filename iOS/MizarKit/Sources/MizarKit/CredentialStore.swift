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
    /// The host's display name.
    public let hostName: String
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
    ) {
        self.hostId = hostId
        self.hostName = hostName
        self.authority = authority
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.pairedAt = pairedAt
        self.baseURL = baseURL
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

/// Storage for the paired-host credential.
public protocol CredentialStore: Sendable {
    /// Read the stored pairing.
    /// - Returns: the pairing, or `nil` when this device is not paired.
    func load() async throws -> PairedHost?

    /// Replace the stored pairing.
    /// - Parameter host: the pairing to store.
    func save(_ host: PairedHost) async throws

    /// Remove the stored pairing.
    func clear() async throws
}

/// A store that keeps the pairing in memory only.
///
/// For tests, and for previews. Explicitly not a fallback for a failed Keychain
/// write: silently degrading to memory would mean a pairing that appears to work
/// and vanishes on the next launch.
public actor InMemoryCredentialStore: CredentialStore {
    private var host: PairedHost?

    public init(host: PairedHost? = nil) {
        self.host = host
    }

    public func load() async throws -> PairedHost? { host }

    public func save(_ host: PairedHost) async throws { self.host = host }

    public func clear() async throws { host = nil }
}

/// The Keychain-backed store.
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

    public func load() async throws -> PairedHost? {
        #if canImport(Security)
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw MizarError(
                code: "KEYCHAIN_READ_FAILED",
                message: "could not read the pairing from the keychain (status \(status))",
            )
        }
        return try JSONDecoder().decode(PairedHost.self, from: data)
        #else
        return nil
        #endif
    }

    public func save(_ host: PairedHost) async throws {
        #if canImport(Security)
        let data = try JSONEncoder().encode(host)

        // Update first, then add: SecItemAdd fails with errSecDuplicateItem when
        // an item already exists, and deleting-then-adding would open a window
        // where the credential does not exist.
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
        _ = host
        throw MizarError(
            code: "KEYCHAIN_UNAVAILABLE",
            message: "no keychain on this platform",
        )
        #endif
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
}
