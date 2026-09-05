import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, createFusionCredentialStore, createFusionModelRegistry, getFusionAuthPath } from "../auth/auth-storage.js";

// FNXC:ProviderAuth 2026-09-05-08:03: synthetic external login, no personal profile or network.
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(expired = false) {
  const root = mkdtempSync(join(tmpdir(), "fusion external auth ")); roots.push(root);
  const home = join(root, "isolated"); mkdirSync(home);
  const source = join(root, "auth.json");
  const access = "header." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600) })).toString("base64url") + ".signature";
  const bytes = JSON.stringify({ tokens: { access_token: access, refresh_token: "synthetic-only", account_id: "fixture" } });
  writeFileSync(source, bytes);
  vi.stubEnv("HOME", home); vi.stubEnv("FUSION_CODEX_AUTH_FILE", source);
  return { home, source, bytes, access };
}
describe("explicit read-only external Codex login", () => {
  it("observes owner rotation and revocation at use time without copying credentials", async () => {
    const f = fixture(); const auth = createFusionAuthStorage();
    const changed = JSON.parse(f.bytes);
    changed.tokens.access_token = "rotated." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url") + ".signature";
    writeFileSync(f.source, JSON.stringify(changed));
    auth.reload();
    expect(await auth.getApiKey("openai-codex")).toBe(changed.tokens.access_token);
    expect(await createFusionCredentialStore(auth).read("openai-codex")).toMatchObject({ access: changed.tokens.access_token });
    // Synthetic file only; simulates the credential owner's revocation.
    rmSync(f.source);
    expect(auth.hasAuth("openai-codex")).toBe(false);
    expect(auth.list()).toEqual([]);
    expect(await auth.getApiKey("openai-codex")).toBeUndefined();
    expect(await createFusionCredentialStore(auth).read("openai-codex")).toBeUndefined();
    expect(existsSync(getFusionAuthPath(f.home))).toBe(false);
  });
  it("agrees on near-expiry unavailability across status and runtime", async () => {
    const f = fixture(); const auth = createFusionAuthStorage();
    const changed = JSON.parse(f.bytes);
    changed.tokens.access_token = "near." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url") + ".signature";
    writeFileSync(f.source, JSON.stringify(changed));
    expect(auth.hasAuth("openai-codex")).toBe(false);
    expect(auth.list()).toEqual([]);
    expect(await auth.getApiKey("openai-codex")).toBeUndefined();
    expect(await createFusionCredentialStore(auth).read("openai-codex")).toBeUndefined();
  });
  it("uses the exact file in memory without hydration or a refresh capability", async () => {
    const f = fixture(); const auth = createFusionAuthStorage();
    expect(await auth.getApiKey("openai-codex")).toBe(f.access);
    const runtime = createFusionCredentialStore(auth);
    expect(await runtime.read("openai-codex")).toMatchObject({ type: "oauth", access: f.access });
    await expect(auth.set("openai-codex", { type: "api_key", key: "replacement" })).rejects.toThrow("read-only");
    await expect(auth.modify("openai-codex", vi.fn())).rejects.toThrow("read-only");
    await expect(auth.remove("openai-codex")).rejects.toThrow("read-only");
    auth.reload();
    expect(readFileSync(f.source, "utf8")).toBe(f.bytes);
    expect(existsSync(getFusionAuthPath(f.home))).toBe(false);
  });
  it("resolves auth through the real OAuth-only model runtime without network", async () => {
    const f = fixture(); const auth = createFusionAuthStorage();
    const registry = await createFusionModelRegistry(auth);
    expect(await registry.modelRuntime.getAuth("openai-codex")).toMatchObject({ auth: { apiKey: f.access } });
    expect(existsSync(getFusionAuthPath(f.home))).toBe(false);
  });
  it("refuses expired access rather than rotating the owner's refresh token", async () => {
    const f = fixture(true); const auth = createFusionAuthStorage();
    expect(await createFusionCredentialStore(auth).read("openai-codex")).toBeUndefined();
    expect(readFileSync(f.source, "utf8")).toBe(f.bytes);
    expect(existsSync(getFusionAuthPath(f.home))).toBe(false);
  });
  it("does not fall back to sibling credential files when the exact file is absent", async () => {
    const f = fixture(); vi.stubEnv("FUSION_CODEX_AUTH_FILE", join(f.home, "absent.json"));
    const agent = join(f.home, ".fusion", "agent"); mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ other: { type: "api_key", key: "must-not-load" } }));
    expect(createFusionAuthStorage().list()).toEqual([]);
  });
  it("rejects relative explicit auth paths", () => {
    fixture(); vi.stubEnv("FUSION_CODEX_AUTH_FILE", "auth.json");
    expect(() => createFusionAuthStorage()).toThrow("must be absolute");
  });
});
