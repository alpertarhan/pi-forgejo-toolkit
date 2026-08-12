import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import type { CommandExecutor } from "../src/process.js";
import {
  runForgejoSetup,
  writeForgejoConfigAtomic,
  type ForgejoSetupOptions,
  type SetupStage,
} from "../src/setup.js";

type ScriptStep =
  | { kind: "select"; match?: string }
  | { kind: "input"; value?: string }
  | { kind: "confirm"; value: boolean };

interface ScriptedUi {
  ui: ForgejoSetupOptions["ui"];
  notify: ReturnType<typeof vi.fn>;
  assertComplete(): void;
}

function scriptedUi(script: ScriptStep[]): ScriptedUi {
  const remaining = [...script];
  const notify = vi.fn();
  const take = <T extends ScriptStep["kind"]>(kind: T): Extract<ScriptStep, { kind: T }> => {
    const step = remaining.shift();
    if (!step || step.kind !== kind) {
      throw new Error(`expected scripted ${kind}, received ${step?.kind ?? "end of script"}`);
    }
    return step as Extract<ScriptStep, { kind: T }>;
  };
  const ui = {
    select: vi.fn(async (_title: string, options: string[]) => {
      const step = take("select");
      if (step.match === undefined) return undefined;
      const selected = options.find((option) => option.includes(step.match ?? ""));
      if (!selected) throw new Error(`no option matching '${step.match}' in: ${options.join(" | ")}`);
      return selected;
    }),
    input: vi.fn(async () => take("input").value),
    confirm: vi.fn(async () => take("confirm").value),
    notify,
  } as unknown as ForgejoSetupOptions["ui"];
  return {
    ui,
    notify,
    assertComplete() {
      expect(remaining).toEqual([]);
    },
  };
}

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-forgejo-setup-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("guided Forgejo setup", () => {
  it("guides API-token setup, validates input, and writes custom dashboard choices without a token", async () => {
    const root = await temporaryRoot();
    const target = join(root, "forgejo.json");
    const scripted = scriptedUi([
      { kind: "select", match: "Global" },
      { kind: "select", match: "API token environment variable" },
      { kind: "input", value: "not-a-url" },
      { kind: "input", value: "https://git.acme.example/forgejo" },
      { kind: "input", value: "Bad Alias" },
      { kind: "input", value: "" },
      { kind: "input", value: "bad token name" },
      { kind: "input", value: "" },
      { kind: "select", match: "Keep 'FORGEJO_ACME_TOKEN'" },
      { kind: "select", match: "detected server hostname only" },
      { kind: "select", match: "Continue to dashboard" },
      { kind: "select", match: "Custom" },
      { kind: "select", match: "widget hidden" },
      { kind: "select", match: "current repository" },
      { kind: "select", match: "All attention" },
      { kind: "select", match: "Counts only" },
      { kind: "select", match: "Custom value" },
      { kind: "input", value: "42" },
      { kind: "select", match: "Custom value" },
      { kind: "input", value: "7" },
      { kind: "select", match: "Write configuration" },
    ]);
    const exec = vi.fn<CommandExecutor>();
    const stages: SetupStage[] = [];

    const result = await runForgejoSetup({
      args: "",
      cwd: root,
      ui: scripted.ui,
      exec,
      environment: { PI_FORGEJO_CONFIG: target },
      onStage: (stage) => stages.push(stage),
    });

    expect(result).toMatchObject({ scope: "global", target });
    expect(result?.config.servers.acme).toEqual({
      baseUrl: "https://git.acme.example/forgejo",
      hostname: "git.acme.example",
      credentialProvider: "env",
      tokenEnv: "FORGEJO_ACME_TOKEN",
      remoteHosts: ["git.acme.example"],
    });
    expect(result?.config.dashboard).toEqual({
      enabled: false,
      scope: "current",
      refreshSeconds: 42,
      previewLimit: 7,
      notifications: "all",
      privacy: "counts-only",
    });
    const written = await readFile(target, "utf8");
    expect(written).toContain('"tokenEnv": "FORGEJO_ACME_TOKEN"');
    expect(written).not.toContain("token-value");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(exec).not.toHaveBeenCalled();
    expect(scripted.notify.mock.calls.flat().join(" ")).toContain("Alias must contain lowercase letters");
    expect(scripted.notify.mock.calls.flat().join(" ")).toContain("Environment variable must begin");
    expect(stages).toEqual(["scope", "servers", "dashboard", "review"]);
    scripted.assertComplete();
  });

  it("discovers multiple fgj profiles and writes project configuration", async () => {
    const root = await temporaryRoot();
    const scripted = scriptedUi([
      { kind: "select", match: "Discover servers" },
      { kind: "select", match: "default fgj" },
      { kind: "select", match: "Add this Forgejo server" },
      { kind: "input", value: "work" },
      { kind: "select", match: "detected server hostname only" },
      { kind: "select", match: "Add this Forgejo server" },
      { kind: "input", value: "" },
      { kind: "select", match: "detected server hostname only" },
      { kind: "select", match: "Continue to dashboard" },
      { kind: "select", match: "On demand" },
      { kind: "select", match: "Write configuration" },
    ]);
    const exec = vi.fn<CommandExecutor>(async () => ({
      code: 0,
      stdout: "Authenticated instances:\n\n  • git.acme.example (user: alice)\n  • code.community.example (user: alice)\n",
      stderr: "",
    }));

    const result = await runForgejoSetup({ args: "project", cwd: root, ui: scripted.ui, exec, environment: {} });

    const target = join(root, ".pi", "forgejo.json");
    expect(result).toMatchObject({ scope: "project", target });
    expect(result?.config.servers).toMatchObject({
      work: { hostname: "git.acme.example", credentialProvider: "fgj" },
      community: { hostname: "code.community.example", credentialProvider: "fgj" },
    });
    expect(result?.config.dashboard).toMatchObject({ enabled: false, notifications: "off" });
    expect(exec).toHaveBeenCalledWith("fgj", ["auth", "status"], { cwd: root, timeout: 10_000 });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(result?.config);
    scripted.assertComplete();
  });

  it("reconfigures an existing server while preserving dashboard settings and normalizing permissions", async () => {
    const root = await temporaryRoot();
    const target = join(root, "forgejo.json");
    const existing = {
      servers: {
        work: {
          baseUrl: "https://git.work.example",
          credentialProvider: "env",
          tokenEnv: "FORGEJO_WORK_TOKEN",
          remoteHosts: ["forgejo-work"],
        },
      },
      dashboard: {
        enabled: true,
        scope: "current",
        refreshSeconds: 300,
        previewLimit: 5,
        notifications: "off",
        privacy: "full",
      },
    };
    await writeFile(target, JSON.stringify(existing), { mode: 0o644 });
    const scripted = scriptedUi([
      { kind: "select", match: "Update existing" },
      { kind: "select", match: "Reconfigure an existing server" },
      { kind: "select", match: "work —" },
      { kind: "input", value: "" },
      { kind: "input", value: "FORGEJO_WORK_TOKEN_V2" },
      { kind: "select", match: "Keep current SSH aliases" },
      { kind: "select", match: "Continue to dashboard" },
      { kind: "select", match: "Keep current settings" },
      { kind: "select", match: "Write configuration" },
    ]);

    const result = await runForgejoSetup({
      args: "global",
      cwd: root,
      ui: scripted.ui,
      exec: vi.fn<CommandExecutor>(),
      environment: { PI_FORGEJO_CONFIG: target, FORGEJO_WORK_TOKEN_V2: "new-token-value" },
    });

    expect(result?.config.dashboard).toEqual(existing.dashboard);
    expect(result?.config.servers.work?.tokenEnv).toBe("FORGEJO_WORK_TOKEN_V2");
    expect(result?.config.servers.work?.remoteHosts).toEqual(["git.work.example", "forgejo-work"]);
    expect(await readFile(target, "utf8")).not.toContain("new-token-value");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    scripted.assertComplete();
  });

  it("does not overwrite a configuration changed while the wizard is open", async () => {
    const root = await temporaryRoot();
    const target = join(root, "forgejo.json");
    const original = "{\"before\":true}\n";
    const changed = "{\"changed\":true}\n";
    await writeFile(target, original);
    await writeFile(target, changed);
    const config = parseConfig({ servers: { work: { hostname: "git.work.example", credentialProvider: "fgj" } } });

    await expect(writeForgejoConfigAtomic(target, config, original)).rejects.toThrow("changed while setup was open");
    await expect(readFile(target, "utf8")).resolves.toBe(changed);
  });

  it("leaves no file when the guided flow is cancelled", async () => {
    const root = await temporaryRoot();
    const target = join(root, "forgejo.json");
    const scripted = scriptedUi([{ kind: "select", match: "Cancel setup" }]);

    await expect(
      runForgejoSetup({
        args: "global",
        cwd: root,
        ui: scripted.ui,
        exec: vi.fn<CommandExecutor>(),
        environment: { PI_FORGEJO_CONFIG: target },
      }),
    ).resolves.toBeUndefined();
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    scripted.assertComplete();
  });
});
