import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { boundModelText, positiveLimit, toolResult, type RuntimeProvider } from "./common.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function repositoryName(value: Record<string, unknown>): string | undefined {
  const repository = record(value.repository);
  return repository ? stringField(repository, "full_name") : undefined;
}

function formatSearchItem(server: string, action: "issues" | "pulls" | "repositories" | "users", value: unknown): string {
  const item = record(value);
  if (!item) return String(value);
  if (action === "issues" || action === "pulls") {
    const number = typeof item.number === "number" ? item.number : "?";
    const repository = repositoryName(item) ?? "unknown/unknown";
    const reference = `${server}:${repository}${action === "pulls" ? "!" : "#"}${number}`;
    const lines = [
      `${reference} ${stringField(item, "title") ?? "(untitled)"} [${stringField(item, "state") ?? "unknown"}]`,
      `Author: ${stringField(record(item.user) ?? {}, "login") ?? stringField(item, "original_author") ?? "unknown"}`,
      `Updated: ${stringField(item, "updated_at") ?? "unknown"}`,
    ];
    const body = stringField(item, "body");
    if (body) lines.push("Body:", body);
    const webUrl = stringField(item, "html_url");
    if (webUrl) lines.push(`URL: ${webUrl}`);
    return lines.join("\n");
  }
  if (action === "repositories") {
    const fullName = stringField(item, "full_name") ?? stringField(item, "name") ?? "unknown";
    const lines = [`${server}:${fullName}`];
    const description = stringField(item, "description");
    if (description) lines.push(description);
    const webUrl = stringField(item, "html_url");
    if (webUrl) lines.push(`URL: ${webUrl}`);
    return lines.join("\n");
  }
  const login = stringField(item, "login") ?? "unknown";
  const lines = [`${server} user @${login}`];
  const fullName = stringField(item, "full_name");
  if (fullName) lines.push(`Name: ${fullName}`);
  const webUrl = stringField(item, "html_url");
  if (webUrl) lines.push(`URL: ${webUrl}`);
  return lines.join("\n");
}


export function registerSearchTool(pi: ExtensionAPI, runtimeProvider: RuntimeProvider): void {
  pi.registerTool({
    name: "forgejo_search",
    label: "Forgejo Search",
    description: "Search issues, pull requests, repositories, or users across configured Forgejo servers. Every result retains its server identity.",
    promptSnippet: "Search Forgejo resources across one or every configured server",
    parameters: Type.Object({
      action: StringEnum(["issues", "pulls", "repositories", "users"] as const),
      query: Type.String({ minLength: 1 }),
      server: Type.Optional(Type.String()),
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1000000 })),
    }),
    async execute(_toolCallId, params, signal) {
      const runtime = runtimeProvider();
      const aliases = params.server ? [params.server] : runtime.clients.aliases();
      for (const alias of aliases) runtime.client(alias);
      const limit = positiveLimit(params.limit, 20);
      const requestOptions = signal === undefined ? {} : { signal };
      const results: Array<{ server: string; total: number; items: unknown[] }> = [];
      const errors: Record<string, string> = {};

      await Promise.all(
        aliases.map(async (alias) => {
          const client = runtime.client(alias);
          try {
            const path = params.action === "repositories" ? "repos/search" : params.action === "users" ? "users/search" : "repos/issues/search";
            const query =
              params.action === "issues" || params.action === "pulls"
                ? { q: params.query, state: params.state ?? "open", type: params.action, page: params.page ?? 1, limit }
                : { q: params.query, page: params.page ?? 1, limit };
            const response = await client.request<unknown[] | { data?: unknown[]; ok?: boolean }>(path, {
              ...requestOptions,
              query,
            });
            const items = Array.isArray(response.data) ? response.data : (response.data.data ?? []);
            results.push({ server: alias, total: response.totalCount ?? items.length, items });
          } catch (error) {
            errors[alias] = error instanceof Error ? error.message : String(error);
          }
        }),
      );

      const summaryParts = results.map((result) => `${result.server}: ${result.total}`);
      for (const alias of Object.keys(errors)) summaryParts.push(`${alias}: error`);
      const entries = results.flatMap((result) => result.items.map((item) => formatSearchItem(result.server, params.action, item)));
      const text = [`${params.action} search '${params.query}' | ${summaryParts.join(" | ")}`, ...entries].join("\n\n");
      const bounded = boundModelText(text, params.max_bytes ?? 200_000);
      return toolResult(bounded.text, {
        results,
        errors,
        truncated: bounded.truncated,
        originalBytes: bounded.originalBytes,
        renderedBytes: bounded.renderedBytes,
      });
    },
  });
}
