import { describe, expect, it, vi } from "vitest";
import { CredentialError, EnvironmentCredentialProvider, FgjCredentialProvider } from "../src/credentials.js";
import type { CommandExecutor, CommandResult } from "../src/process.js";

describe("EnvironmentCredentialProvider", () => {
  it("reads an API token directly from the configured environment without invoking a CLI", async () => {
    const provider = new EnvironmentCredentialProvider("work", "FORGEJO_WORK_TOKEN", {
      FORGEJO_WORK_TOKEN: "api-token",
    });

    expect(provider.kind).toBe("env");
    await expect(provider.getToken()).resolves.toBe("api-token");
    provider.clear();
    await expect(provider.getToken()).resolves.toBe("api-token");
  });

  it("rejects missing or whitespace-bearing token values without exposing them", async () => {
    const missing = new EnvironmentCredentialProvider("work", "FORGEJO_WORK_TOKEN", {});
    const invalid = new EnvironmentCredentialProvider("work", "FORGEJO_WORK_TOKEN", {
      FORGEJO_WORK_TOKEN: "secret token",
    });

    await expect(missing.getToken()).rejects.toThrow("FORGEJO_WORK_TOKEN is not set");
    await expect(invalid.getToken()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as Error).message).toContain("FORGEJO_WORK_TOKEN is invalid");
      expect((error as Error).message).not.toContain("secret token");
      return true;
    });
  });
});

describe("FgjCredentialProvider", () => {
  it("loads a token once, keeps it out of process arguments, and reloads after clear", async () => {
    const exec = vi.fn<CommandExecutor>(async () => ({ code: 0, stdout: "secret-token\n", stderr: "" }));
    const provider = new FgjCredentialProvider("work", "git.example.dev", "/workspace", exec);

    await expect(Promise.all([provider.getToken(), provider.getToken()])).resolves.toEqual([
      "secret-token",
      "secret-token",
    ]);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toBe("fgj");
    expect(exec.mock.calls[0]?.[1]).toEqual(["auth", "token", "--hostname", "git.example.dev"]);
    expect(exec.mock.calls.flatMap((call) => call[1])).not.toContain("secret-token");

    provider.clear();
    await expect(provider.getToken()).resolves.toBe("secret-token");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("aborts and refuses to cache a cleared in-flight credential", async () => {
    let settleFirst: ((result: CommandResult) => void) | undefined;
    const firstResult = new Promise<CommandResult>((resolve) => {
      settleFirst = resolve;
    });
    let calls = 0;
    const exec = vi.fn<CommandExecutor>(async () => {
      calls += 1;
      if (calls === 1) return firstResult;
      return { code: 0, stdout: "fresh-token\n", stderr: "" };
    });
    const provider = new FgjCredentialProvider("work", "git.example.dev", "/workspace", exec);

    const pending = provider.getToken();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
    const commandSignal = exec.mock.calls[0]?.[2].signal;
    provider.clear();
    expect(commandSignal?.aborted).toBe(true);
    settleFirst?.({ code: 0, stdout: "stale-token\n", stderr: "" });

    await expect(pending).rejects.toBeInstanceOf(CredentialError);
    await expect(provider.getToken()).resolves.toBe("fresh-token");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not expose command stdout when fgj authentication fails", async () => {
    const exec = vi.fn<CommandExecutor>(async () => ({
      code: 1,
      stdout: "secret-token\n",
      stderr: "credential unavailable",
    }));
    const provider = new FgjCredentialProvider("work", "git.example.dev", "/workspace", exec);

    await expect(provider.getToken()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as Error).message).toContain("credential unavailable");
      expect((error as Error).message).not.toContain("secret-token");
      return true;
    });
  });
});
