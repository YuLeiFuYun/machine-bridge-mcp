import Foundation
import Security
import LocalAuthentication

private enum BrokerError: Error, CustomStringConvertible {
    case usage(String)
    case security(OSStatus, String)
    case invalidKey(String)
    case invalidInput(String)

    var description: String {
        switch self {
        case .usage(let value), .invalidKey(let value), .invalidInput(let value): return value
        case .security(let status, let operation):
            let text = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "\(operation) failed: \(text)"
        }
    }
}

private struct Output: Encodable {
    let ok: Bool
    let provider: String
    let keyTag: String
    let publicJwk: PublicJwk?
    let signature: String?
    let secureEnclave: Bool
}

private struct PublicJwk: Codable {
    let kty: String
    let crv: String
    let x: String
    let y: String
}

private let providerName = "macos-secure-enclave-v1"

@main
private struct MachineBridgeTrustBroker {
    static func main() {
        do {
            let arguments = CommandLine.arguments
            guard arguments.count >= 4, arguments[2] == "--tag" else {
                throw BrokerError.usage("usage: machine-bridge-trust-broker <ensure|public|sign|delete|status> --tag <tag> [--reason <text>]")
            }
            let action = arguments[1]
            let tag = arguments[3]
            guard tag.range(of: #"^[A-Za-z0-9._-]{8,180}$"#, options: .regularExpression) != nil else {
                throw BrokerError.invalidInput("key tag is invalid")
            }
            let reason = option("--reason", in: arguments) ?? "Authorize Machine Bridge startup"
            let result: Output
            switch action {
            case "ensure":
                let key = try ensurePrivateKey(tag: tag)
                result = try output(tag: tag, key: key, signature: nil)
            case "public":
                let key = try loadPrivateKey(tag: tag, prompt: nil, allowInteraction: false)
                result = try output(tag: tag, key: key, signature: nil)
            case "status":
                let key = try? loadPrivateKey(tag: tag, prompt: nil, allowInteraction: false)
                if let key {
                    result = try output(tag: tag, key: key, signature: nil)
                } else {
                    result = Output(ok: false, provider: providerName, keyTag: tag, publicJwk: nil, signature: nil, secureEnclave: secureEnclaveAvailable())
                }
            case "sign":
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard !data.isEmpty, data.count <= 64 * 1024 else { throw BrokerError.invalidInput("signing input is empty or too large") }
                guard String(data: data, encoding: .utf8) != nil else { throw BrokerError.invalidInput("signing input is not UTF-8") }
                let key = try loadPrivateKey(tag: tag, prompt: reason, allowInteraction: true)
                var error: Unmanaged<CFError>?
                guard let der = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else {
                    throw error?.takeRetainedValue() ?? BrokerError.invalidKey("Secure Enclave signing failed")
                }
                let raw = try derToP1363(der)
                result = try output(tag: tag, key: key, signature: raw.base64URLEncodedString())
            case "delete":
                let status = SecItemDelete(keyQuery(tag: tag, returnRef: false, allowInteraction: false, prompt: nil) as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { throw BrokerError.security(status, "delete key") }
                result = Output(ok: true, provider: providerName, keyTag: tag, publicJwk: nil, signature: nil, secureEnclave: secureEnclaveAvailable())
            default:
                throw BrokerError.usage("unknown action: \(action)")
            }
            try emit(result)
        } catch {
            let message = String(describing: error)
            FileHandle.standardError.write(Data("machine-bridge-trust-broker: \(message)\n".utf8))
            exit(1)
        }
    }
}

private func ensurePrivateKey(tag: String) throws -> SecKey {
    if let existing = try? loadPrivateKey(tag: tag, prompt: nil, allowInteraction: false) { return existing }
    guard secureEnclaveAvailable() else { throw BrokerError.invalidKey("Secure Enclave is unavailable") }
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .userPresence],
        &accessError
    ) else {
        throw accessError?.takeRetainedValue() ?? BrokerError.invalidKey("could not create Secure Enclave access control")
    }
    let privateAttributes: [String: Any] = [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: Data(tag.utf8),
        kSecAttrAccessControl as String: access,
    ]
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: privateAttributes,
    ]
    var keyError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
        throw keyError?.takeRetainedValue() ?? BrokerError.invalidKey("could not create Secure Enclave key")
    }
    return key
}

private func loadPrivateKey(tag: String, prompt: String?, allowInteraction: Bool) throws -> SecKey {
    let query = keyQuery(tag: tag, returnRef: true, allowInteraction: allowInteraction, prompt: prompt)
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let key = result as! SecKey? else { throw BrokerError.security(status, "load Secure Enclave key") }
    return key
}

private func keyQuery(tag: String, returnRef: Bool, allowInteraction: Bool, prompt: String?) -> [String: Any] {
    var query: [String: Any] = [
        kSecClass as String: kSecClassKey,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag as String: Data(tag.utf8),
        kSecReturnRef as String: returnRef,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    let context = LAContext()
    if allowInteraction {
        context.localizedReason = prompt ?? "Authorize Machine Bridge startup"
    } else {
        context.interactionNotAllowed = true
    }
    query[kSecUseAuthenticationContext as String] = context
    return query
}

private func output(tag: String, key: SecKey, signature: String?) throws -> Output {
    guard let publicKey = SecKeyCopyPublicKey(key) else { throw BrokerError.invalidKey("public key is unavailable") }
    var error: Unmanaged<CFError>?
    guard let external = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        throw error?.takeRetainedValue() ?? BrokerError.invalidKey("public key export failed")
    }
    guard external.count == 65, external.first == 0x04 else { throw BrokerError.invalidKey("public key representation is invalid") }
    let x = external.subdata(in: 1..<33).base64URLEncodedString()
    let y = external.subdata(in: 33..<65).base64URLEncodedString()
    return Output(
        ok: true,
        provider: providerName,
        keyTag: tag,
        publicJwk: PublicJwk(kty: "EC", crv: "P-256", x: x, y: y),
        signature: signature,
        secureEnclave: true
    )
}

private func secureEnclaveAvailable() -> Bool {
    let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
    ]
    var error: Unmanaged<CFError>?
    return SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil
}

private func derToP1363(_ data: Data) throws -> Data {
    var index = 0
    func readByte() throws -> UInt8 {
        guard index < data.count else { throw BrokerError.invalidInput("ECDSA signature is truncated") }
        defer { index += 1 }
        return data[index]
    }
    func readLength() throws -> Int {
        let first = try readByte()
        if first < 0x80 { return Int(first) }
        let count = Int(first & 0x7f)
        guard count > 0, count <= 2 else { throw BrokerError.invalidInput("ECDSA signature length is invalid") }
        var length = 0
        for _ in 0..<count { length = (length << 8) | Int(try readByte()) }
        return length
    }
    guard try readByte() == 0x30 else { throw BrokerError.invalidInput("ECDSA signature sequence is invalid") }
    let sequenceLength = try readLength()
    guard sequenceLength == data.count - index else { throw BrokerError.invalidInput("ECDSA signature sequence length is invalid") }
    func readInteger() throws -> Data {
        guard try readByte() == 0x02 else { throw BrokerError.invalidInput("ECDSA signature integer is invalid") }
        let length = try readLength()
        guard length > 0, index + length <= data.count else { throw BrokerError.invalidInput("ECDSA signature integer is truncated") }
        var value = data.subdata(in: index..<(index + length))
        index += length
        while value.count > 32, value.first == 0 { value.removeFirst() }
        guard value.count <= 32 else { throw BrokerError.invalidInput("ECDSA signature integer is too large") }
        if value.count < 32 { value = Data(repeating: 0, count: 32 - value.count) + value }
        return value
    }
    let r = try readInteger()
    let s = try readInteger()
    guard index == data.count else { throw BrokerError.invalidInput("ECDSA signature has trailing bytes") }
    return r + s
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

private func emit<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
