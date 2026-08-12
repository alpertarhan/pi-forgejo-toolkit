import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { formatResourceRef } from "../refs.js";
import type { DashboardItem, ResourceRef } from "../types.js";
import { DashboardStore } from "./store.js";

interface ForgejoToken {
  marker: "#" | "!";
  query: string;
}

function extractToken(textBeforeCursor: string): ForgejoToken | undefined {
  const match = /(?:^|[ \t])([#!])([^\s#!]*)$/.exec(textBeforeCursor);
  if (!match || (match[1] !== "#" && match[1] !== "!")) return undefined;
  return { marker: match[1], query: match[2] ?? "" };
}

function candidates(store: DashboardStore, marker: "#" | "!"): DashboardItem[] {
  const snapshot = store.snapshot();
  const items = Object.values(snapshot.servers).flatMap((server) =>
    marker === "#"
      ? server.assignedIssues.items
      : [...server.reviewRequests.items, ...server.authoredPulls.items],
  );
  const unique = new Map<string, DashboardItem>();
  for (const item of items) {
    const key = `${item.server}:${item.owner}/${item.repo}:${item.index}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) => {
    const active = snapshot.activeRepo;
    const leftActive = Boolean(active && left.server === active.server && left.owner === active.owner && left.repo === active.repo);
    const rightActive = Boolean(active && right.server === active.server && right.owner === active.owner && right.repo === active.repo);
    return Number(rightActive) - Number(leftActive) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function autocompleteItem(store: DashboardStore, item: DashboardItem): AutocompleteItem {
  const snapshot = store.snapshot();
  const active = snapshot.activeRepo;
  const ref: ResourceRef = {
    server: item.server,
    owner: item.owner,
    repo: item.repo,
    kind: item.resourceKind === "pull" ? "pull" : "issue",
    index: item.index ?? 0,
  };
  const marker = ref.kind === "pull" ? "!" : "#";
  const isActive = Boolean(active && active.server === item.server && active.owner === item.owner && active.repo === item.repo);
  const value = isActive ? `${marker}${ref.index}` : formatResourceRef(ref);
  return {
    value,
    label: value,
    description: `[${item.kind}] ${item.title}`,
  };
}

function suggestions(store: DashboardStore, token: ForgejoToken): AutocompleteItem[] {
  const items = candidates(store, token.marker);
  const matches = token.query
    ? /^\d+$/.test(token.query)
      ? items.filter((item) => String(item.index ?? "").startsWith(token.query))
      : fuzzyFilter(items, token.query, (item) => `${item.index ?? ""} ${item.server} ${item.owner} ${item.repo} ${item.title}`)
    : items;
  return matches.slice(0, 20).map((item) => autocompleteItem(store, item));
}

export function createForgejoAutocompleteProvider(current: AutocompleteProvider, store: DashboardStore): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const token = extractToken(currentLine.slice(0, cursorCol));
      if (!token || options.signal.aborted) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const items = suggestions(store, token);
      if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      return { items, prefix: `${token.marker}${token.query}` };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
