import { describe, expect, it } from "vitest";
import { Http2Settings } from "@browsercore/http2";
import type { BrowserProfile, ProfileId } from "@browsercore/profiles";
import {
    ALPN_PROTOCOLS,
    applyHttp1Profile,
    profileHttp2Settings,
    profileToTlsConfig,
} from "../src/profile.js";
import { FetchError } from "../src/errors.js";

/** Build a minimal valid profile for translation tests. */
function makeProfile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
    return {
        id: "default" as ProfileId,
        name: "default",
        version: "1.0.0",
        tls: {
            cipherSuites: ["TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256"],
            extensionOrder: [0, 10, 11],
            supportedVersions: ["TLS 1.3", "TLS 1.2"],
            keyShareGroups: ["x25519", "secp256r1"],
            signatureAlgorithms: ["ecdsa_secp256r1_sha256", "rsa_pss_rsae_sha256"],
            grease: false,
        },
        http2: {
            settings: {
                headerTableSize: 4096,
                enablePush: true,
                maxConcurrentStreams: 128,
                initialWindowSize: 65535,
                maxFrameSize: 16384,
                maxHeaderListSize: 8192,
            },
            initialWindowSize: 65535,
            maxFrameSize: 16384,
            headerTableSize: 4096,
            weight: 16,
        },
        http1: {
            defaultHeaders: { "user-agent": "test/1.0", accept: "*/*" },
            headerOrder: ["user-agent", "accept"],
            connection: "keep-alive",
            acceptEncoding: "gzip, deflate, br",
        },
        ...overrides,
    };
}

describe("ALPN_PROTOCOLS", () => {
    it("offers h2 before http/1.1 (h2 preferred)", () => {
        expect(ALPN_PROTOCOLS).toEqual(["h2", "http/1.1"]);
    });
});

describe("profileToTlsConfig", () => {
    it("translates every TLS field and injects the server name + ALPN", () => {
        const cfg = profileToTlsConfig(makeProfile(), "example.com");
        expect(cfg.cipherSuites).toEqual(["TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256"]);
        expect(cfg.keyShareGroups).toEqual(["x25519", "secp256r1"]);
        expect(cfg.signatureAlgorithms).toEqual([
            "ecdsa_secp256r1_sha256",
            "rsa_pss_rsae_sha256",
        ]);
        expect(cfg.serverName).toBe("example.com");
        expect(cfg.alpnProtocols).toEqual(["h2", "http/1.1"]);
    });

    it("maps supported version strings to wire ProtocolVersion constants", () => {
        const cfg = profileToTlsConfig(makeProfile(), "h");
        // TLS 1.3 -> wire 0x0304; TLS 1.2 -> wire 0x0303.
        expect(cfg.supportedVersions.map((v) => v.wire)).toEqual([0x0304, 0x0303]);
    });

    it("defaults an unrecognized version string to TLS 1.3 (forward-compat)", () => {
        const profile = makeProfile();
        profile.tls.supportedVersions = ["TLS 9.9", "TLS 1.2"];
        const cfg = profileToTlsConfig(profile, "h");
        // Unknown version is treated as the most secure option (1.3).
        expect(cfg.supportedVersions[0]!.name).toBe("TLS 1.3");
        expect(cfg.supportedVersions[1]!.name).toBe("TLS 1.2");
    });

    it("rejects an invalid cipher suite with FetchError", () => {
        const profile = makeProfile();
        profile.tls.cipherSuites = ["TLS_FAKE_SUITE"];
        expect(() => profileToTlsConfig(profile, "h")).toThrow(FetchError);
        try {
            profileToTlsConfig(profile, "h");
        } catch (err) {
            expect((err as FetchError).message).toContain("cipher suite");
            expect((err as FetchError).details.value).toBe("TLS_FAKE_SUITE");
        }
    });

    it("rejects an invalid key-share group with FetchError", () => {
        const profile = makeProfile();
        profile.tls.keyShareGroups = ["brainpool"];
        expect(() => profileToTlsConfig(profile, "h")).toThrow(FetchError);
        try {
            profileToTlsConfig(profile, "h");
        } catch (err) {
            expect((err as FetchError).message).toContain("key-share group");
        }
    });

    it("rejects an invalid signature algorithm with FetchError", () => {
        const profile = makeProfile();
        profile.tls.signatureAlgorithms = ["rsa_pss_rsae_sha512"];
        expect(() => profileToTlsConfig(profile, "h")).toThrow(FetchError);
        try {
            profileToTlsConfig(profile, "h");
        } catch (err) {
            expect((err as FetchError).message).toContain("signature algorithm");
        }
    });

    it("translates each profile field independently (a bad cipher does not affect groups)", () => {
        const profile = makeProfile();
        profile.tls.cipherSuites = ["TLS_AES_256_GCM_SHA384"];
        const cfg = profileToTlsConfig(profile, "h");
        expect(cfg.cipherSuites).toEqual(["TLS_AES_256_GCM_SHA384"]);
        expect(cfg.keyShareGroups).toEqual(["x25519", "secp256r1"]);
    });
});

describe("profileHttp2Settings", () => {
    it("translates every named setting to its wire identifier", () => {
        const wire = profileHttp2Settings(makeProfile());
        expect(wire[Http2Settings.HEADER_TABLE_SIZE]).toBe(4096);
        expect(wire[Http2Settings.MAX_CONCURRENT_STREAMS]).toBe(128);
        expect(wire[Http2Settings.INITIAL_WINDOW_SIZE]).toBe(65535);
        expect(wire[Http2Settings.MAX_FRAME_SIZE]).toBe(16384);
        expect(wire[Http2Settings.MAX_HEADER_LIST_SIZE]).toBe(8192);
    });

    it("coerces enablePush=true to 1", () => {
        const wire = profileHttp2Settings(makeProfile());
        expect(wire[Http2Settings.ENABLE_PUSH]).toBe(1);
    });

    it("coerces enablePush=false to 0", () => {
        const profile = makeProfile();
        profile.http2.settings.enablePush = false;
        const wire = profileHttp2Settings(profile);
        expect(wire[Http2Settings.ENABLE_PUSH]).toBe(0);
    });

    it("omits a setting when the profile leaves it undefined", () => {
        const profile = makeProfile();
        profile.http2.settings = { headerTableSize: 1000 };
        const wire = profileHttp2Settings(profile);
        expect(wire[Http2Settings.HEADER_TABLE_SIZE]).toBe(1000);
        expect(wire[Http2Settings.ENABLE_PUSH]).toBeUndefined();
        expect(wire[Http2Settings.MAX_CONCURRENT_STREAMS]).toBeUndefined();
    });

    it("emits an empty wire map for an empty settings object", () => {
        const profile = makeProfile();
        profile.http2.settings = {};
        expect(profileHttp2Settings(profile)).toEqual({});
    });
});

describe("applyHttp1Profile", () => {
    it("applies default headers that are not already set", () => {
        const headers = new Map<string, string>();
        applyHttp1Profile(headers, makeProfile());
        expect(headers.get("user-agent")).toBe("test/1.0");
        expect(headers.get("accept")).toBe("*/*");
    });

    it("does not overwrite an explicitly-set header", () => {
        const headers = new Map<string, string>([["user-agent", "custom/2.0"]]);
        applyHttp1Profile(headers, makeProfile());
        // Explicit value wins over the profile default.
        expect(headers.get("user-agent")).toBe("custom/2.0");
        expect(headers.get("accept")).toBe("*/*");
    });

    it("is a no-op when the profile has no default headers", () => {
        const profile = makeProfile();
        profile.http1.defaultHeaders = {};
        const headers = new Map<string, string>([["x", "y"]]);
        applyHttp1Profile(headers, profile);
        expect(headers.get("x")).toBe("y");
        expect(headers.size).toBe(1);
    });
});


