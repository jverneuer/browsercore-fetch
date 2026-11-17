/**
 * Test-local deterministic {@link CryptoProvider} for @browsercore/fetch tests.
 *
 * The real Node-backed provider lives in browsersmith (the composition root) —
 * `@browsercore/crypto` ships only primitives, and the `crypto` singleton the
 * old test-platform helper imported does not exist at runtime. Tests that
 * exercise paths past a mocked TLS boundary need only `randomBytes` (the http2
 * layer's PING opaque data); every other method is unreachable there and
 * throws loudly rather than silently returning garbage. `randomBytes` is
 * deterministic so wire captures (e.g. prelude-equality differential tests)
 * stay byte-stable across runs.
 */

import type { CryptoProvider } from "@browsercore/contracts";

/** Error thrown for any primitive the deterministic provider does not carry. */
class DeterministicCryptoError extends Error {
    public constructor(method: string) {
        super(`deterministic test crypto provider does not implement ${method}`);
        this.name = "DeterministicCryptoError";
    }
}

/** Build the deterministic provider. Stateless — one shared instance is fine. */
export function createDeterministicCrypto(): CryptoProvider {
    const unsupported = (method: string): never => {
        throw new DeterministicCryptoError(method);
    };
    return {
        randomBytes(length: number): Uint8Array {
            // Deterministic byte pattern: stable across runs, distinct per
            // length, never accidentally zero-only.
            const out = new Uint8Array(length);
            for (let i = 0; i < length; i += 1) {
                out[i] = (i * 7 + 13) % 256;
            }
            return out;
        },
        sha256: (data) => {
            void data;
            return unsupported("sha256");
        },
        sha384: (data) => {
            void data;
            return unsupported("sha384");
        },
        hkdf: (hash, salt, ikm, info, length) => {
            void hash;
            void salt;
            void ikm;
            void info;
            void length;
            return unsupported("hkdf");
        },
        hmac: (hash, key, data) => {
            void hash;
            void key;
            void data;
            return unsupported("hmac");
        },
        aes128GcmEncrypt: (key, nonce, plaintext, aad) => {
            void key;
            void nonce;
            void plaintext;
            void aad;
            return unsupported("aes128GcmEncrypt");
        },
        aes128GcmDecrypt: (key, nonce, ciphertext, aad) => {
            void key;
            void nonce;
            void ciphertext;
            void aad;
            return unsupported("aes128GcmDecrypt");
        },
        aes256GcmEncrypt: (key, nonce, plaintext, aad) => {
            void key;
            void nonce;
            void plaintext;
            void aad;
            return unsupported("aes256GcmEncrypt");
        },
        aes256GcmDecrypt: (key, nonce, ciphertext, aad) => {
            void key;
            void nonce;
            void ciphertext;
            void aad;
            return unsupported("aes256GcmDecrypt");
        },
        aes128CcmEncrypt: (key, nonce, plaintext, aad) => {
            void key;
            void nonce;
            void plaintext;
            void aad;
            return unsupported("aes128CcmEncrypt");
        },
        aes128CcmDecrypt: (key, nonce, ciphertext, aad) => {
            void key;
            void nonce;
            void ciphertext;
            void aad;
            return unsupported("aes128CcmDecrypt");
        },
        chacha20Poly1305Encrypt: (key, nonce, plaintext, aad) => {
            void key;
            void nonce;
            void plaintext;
            void aad;
            return unsupported("chacha20Poly1305Encrypt");
        },
        chacha20Poly1305Decrypt: (key, nonce, ciphertext, aad) => {
            void key;
            void nonce;
            void ciphertext;
            void aad;
            return unsupported("chacha20Poly1305Decrypt");
        },
        x25519GenerateKeyPair: () => unsupported("x25519GenerateKeyPair"),
        x25519SharedSecret: (secretKey, peerPublicKey) => {
            void secretKey;
            void peerPublicKey;
            return unsupported("x25519SharedSecret");
        },
        ecdhGenerateKeyPair: (curve) => {
            void curve;
            return unsupported("ecdhGenerateKeyPair");
        },
        ecdhSharedSecret: (curve, secretKey, peerPublicKey) => {
            void curve;
            void secretKey;
            void peerPublicKey;
            return unsupported("ecdhSharedSecret");
        },
        verifySignature: (scheme, publicKey, signature, data) => {
            void scheme;
            void publicKey;
            void signature;
            void data;
            return unsupported("verifySignature");
        },
        aesEcbEncrypt: (key, block) => {
            void key;
            void block;
            return unsupported("aesEcbEncrypt");
        },
        mlkem768GenerateKeyPair: () => unsupported("mlkem768GenerateKeyPair"),
        mlkem768Decapsulate: (secretKey, ciphertext) => {
            void secretKey;
            void ciphertext;
            return unsupported("mlkem768Decapsulate");
        },
        x25519MLKEM768SharedSecret: (x25519SecretKey, x25519PeerPublicKey, mlkemSecretKey, mlkemCiphertext) => {
            void x25519SecretKey;
            void x25519PeerPublicKey;
            void mlkemSecretKey;
            void mlkemCiphertext;
            return unsupported("x25519MLKEM768SharedSecret");
        },
    };
}

/** Shared deterministic provider — stateless, safe to reuse across tests. */
export const deterministicCrypto: CryptoProvider = createDeterministicCrypto();
