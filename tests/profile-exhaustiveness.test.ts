import { describe, expect, it } from "vitest";
import { cipherSuiteToWire } from "@browsercore/tls";
import {
    ChromeProfiles,
    EdgeProfiles,
    FirefoxProfiles,
    getProfile,
    SafariProfiles,
} from "@browsercore/profiles";
import { profileToTlsConfig } from "../src/profile.js";

/**
 * The six browser profiles the task calls out as "shipped". Both installed
 * profile packages (0.1.x and 0.2.x) register these ids, so we resolve them by
 * name via {@link getProfile} rather than hard-coding the version-dependent
 * {@link ChromeProfiles} map keys.
 */
const SHIPPED_PROFILE_IDS = [
    "chrome-120",
    "chrome-128",
    "chrome-140",
    "firefox-128",
    "safari-17",
    "edge-120",
] as const;

describe("profileToTlsConfig exhaustiveness", () => {
    it("accepts every shipped browser profile without throwing", () => {
        for (const id of SHIPPED_PROFILE_IDS) {
            const profile = getProfile(id);
            expect(() => profileToTlsConfig(profile, "example.com")).not.toThrow();
        }
    });

    it("translates the TLS fields of every shipped profile", () => {
        for (const id of SHIPPED_PROFILE_IDS) {
            const cfg = profileToTlsConfig(getProfile(id), "example.com");
            expect(cfg.cipherSuites.length).toBeGreaterThan(0);
            expect(cfg.keyShareGroups.length).toBeGreaterThan(0);
            expect(cfg.signatureAlgorithms.length).toBeGreaterThan(0);
            expect(cfg.supportedVersions.length).toBeGreaterThan(0);
            // Server name + ALPN are injected by the translator.
            expect(cfg.serverName).toBe("example.com");
            expect(cfg.alpnProtocols).toEqual(["h2", "http/1.1"]);
        }
    });
});

describe("cipherSuiteToWire exhaustiveness", () => {
    it("wire-encodes every cipher suite every shipped profile advertises", () => {
        for (const id of SHIPPED_PROFILE_IDS) {
            const profile = getProfile(id);
            for (const suite of profile.tls.cipherSuites) {
                const wire = cipherSuiteToWire(suite);
                expect(typeof wire).toBe("number");
                // IANA cipher-suite codes are non-zero uint16.
                expect(Number.isInteger(wire)).toBe(true);
                expect(wire).toBeGreaterThan(0);
                expect(wire).toBeLessThanOrEqual(0xffff);
            }
        }
    });

    it("wire-encodes every cipher suite across the full built-in registry", () => {
        const all = [
            ...Object.values(ChromeProfiles),
            ...Object.values(FirefoxProfiles),
            ...Object.values(SafariProfiles),
            ...Object.values(EdgeProfiles),
        ];
        const seen = new Set<string>();
        for (const profile of all) {
            for (const suite of profile.tls.cipherSuites) {
                if (seen.has(suite)) continue;
                seen.add(suite);
                expect(() => cipherSuiteToWire(suite)).not.toThrow();
            }
        }
    });
});
