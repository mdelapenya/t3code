import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "../ui/button";
import { PULL_REQUEST_BOARD_COLUMNS, type PullRequestBoardColumn } from "./pullRequestBoard.logic";
import { PullRequestListGhost } from "./PullRequestGhosts";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import {
  usePullRequestBoardColumn,
  type PullRequestBoardColumnScope,
} from "../../state/pullRequestBoard";

/** Which pull request the detail panel is showing, so its card reads as the selected one. */
export interface PullRequestBoardSelection {
  /** Absent on a surface opened before the list started naming the server its row came from. */
  readonly environmentId: string | undefined;
  readonly repository: string;
  readonly number: number;
}

interface PullRequestBoardProps {
  readonly environmentQueries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }>;
  readonly scope: PullRequestBoardColumnScope;
  readonly scopeKey: string;
  /** Bumped by the header's refresh and by the live interval; every column re-reads on it. */
  readonly refreshToken: number;
  readonly showProvider: boolean;
  /** Names the server each row was read from, where the workspace has more than one. */
  readonly environmentLabels?: ReadonlyMap<string, string> | undefined;
  readonly selected: PullRequestBoardSelection | null;
  readonly onSelect: (entry: EnvironmentPullRequestEntry) => void;
}

/**
 * The pull requests laid out by review stage rather than by recency: draft, in review, approved,
 * and what has landed. Each column is its own listing with its own count and its own paging, so
 * "what is waiting on a reviewer" is a glance rather than a scroll.
 *
 * Read-only for now — no drag, no diff stats — and GitHub-shaped: a host that does not summarise
 * review decisions cannot be narrowed by them, so its rows land in whichever column its own
 * answer put them.
 */
export function PullRequestBoardView(props: PullRequestBoardProps) {
  return (
    <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
      {PULL_REQUEST_BOARD_COLUMNS.map((column) => (
        <BoardColumn key={column.id} column={column} {...props} />
      ))}
    </div>
  );
}

function BoardColumn({
  column,
  environmentQueries,
  scope,
  scopeKey,
  refreshToken,
  showProvider,
  environmentLabels,
  selected,
  onSelect,
}: PullRequestBoardProps & { readonly column: PullRequestBoardColumn }) {
  const view = usePullRequestBoardColumn(
    column,
    environmentQueries,
    scope,
    `${scopeKey}:${column.id}`,
    refreshToken,
  );
  const rows = useMemo(
    () =>
      view.entries.map((entry) => ({
        entry,
        key: pullRequestEntryKey(entry),
        label: environmentLabels?.get(entry.environmentId),
      })),
    [environmentLabels, view.entries],
  );
  return (
    <section className="flex w-[340px] shrink-0 flex-col rounded-xl border border-border/60 bg-muted/20">
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <h2 className="truncate text-xs font-medium text-foreground">{column.label}</h2>
        <span className="rounded-full bg-muted-foreground/10 px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {view.count}
        </span>
        {view.loadingMore ? (
          <LoaderIcon aria-hidden className="size-3 animate-spin text-muted-foreground/70" />
        ) : null}
      </header>
      {/* Each column scrolls on its own, bounded against the viewport so four of them sit side by
          side rather than turning the page into one very tall scroll. */}
      <div className="min-h-0 max-h-[calc(100dvh-15rem)] flex-1 space-y-0.5 overflow-y-auto px-1 pb-2">
        {view.firstLoad ? (
          <PullRequestListGhost rows={4} />
        ) : view.entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
            Nothing in this stage
          </p>
        ) : (
          rows.map((row) => (
            <PullRequestRow
              key={row.key}
              entry={row.entry}
              showProjectTitle
              showProvider={showProvider}
              {...(row.label === undefined ? {} : { environmentLabel: row.label })}
              selected={
                selected?.environmentId === row.entry.environmentId &&
                selected.repository === row.entry.repository &&
                selected.number === row.entry.number
              }
              onSelect={onSelect}
            />
          ))
        )}
        {view.error !== null ? (
          <div className="mx-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px]">
            <span className="min-w-0">
              {view.entries.length > 0
                ? "The latest request failed. Showing the last pull requests loaded."
                : view.error}
            </span>
            <Button size="xs" variant="outline" onClick={view.retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {/* Held while the next page travels: the answer it will replace is keyed to the page
            that asked for it, so the button would otherwise vanish under the reader's cursor. */}
        {view.canLoadMore || view.loadingMore ? (
          <div className="flex justify-center pt-1">
            <Button size="xs" variant="ghost" disabled={view.loadingMore} onClick={view.loadMore}>
              {view.loadingMore ? "Loading" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
