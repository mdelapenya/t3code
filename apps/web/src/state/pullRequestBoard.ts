import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  appendPullRequestBoardEntries,
  canLoadMorePullRequestBoardColumn,
  firstPullRequestBoardPage,
  formatPullRequestBoardCount,
  MAX_PULL_REQUEST_BOARD_PAGE_SIZE,
  nextPullRequestBoardPage,
  type PullRequestBoardColumn,
  type PullRequestBoardScope,
} from "../components/pullRequest/pullRequestBoard.logic";
import type { EnvironmentPullRequestEntry } from "../components/pullRequest/pullRequestList.logic";
import { usePullRequestList } from "./pullRequests";

/** The board's shared scope, minus the paging each column keeps for itself. */
export type PullRequestBoardColumnScope = Omit<PullRequestBoardScope, "limit" | "cursors">;

export interface PullRequestBoardColumnView {
  readonly entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  /** What the header shows: the hosts' own total where they gave one, the rows loaded where not. */
  readonly count: string;
  readonly error: string | null;
  /** Nothing read and nothing to show, which is the one thing ghosts are for. */
  readonly firstLoad: boolean;
  readonly loadingMore: boolean;
  readonly canLoadMore: boolean;
  readonly loadMore: () => void;
  /** Reads the column again, for the retry beside a failure. */
  readonly retry: () => void;
}

/**
 * One column of the board, read as its own listing. Each column keeps its own page — where every
 * server carries on from, and which of them can only be grown into — so loading more in one
 * column leaves the other three exactly as they were.
 *
 * `refreshToken` is the route's own refresh, bumped when the reader presses refresh or the live
 * interval comes round; a column re-reads from a single page long enough to cover what it is
 * already showing, since a cursored read would only refresh its last slice.
 */
export function usePullRequestBoardColumn(
  column: PullRequestBoardColumn,
  environmentQueries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }>,
  scope: PullRequestBoardColumnScope,
  /** What makes this a different question; the page and the rows held are filed under it. */
  scopeKey: string,
  refreshToken: number,
): PullRequestBoardColumnView {
  const [page, setPage] = useState(() => firstPullRequestBoardPage(scopeKey, column.pageSize));
  // A new scope is a new listing, so the page from the last one is never sent with it.
  useEffect(() => {
    setPage(firstPullRequestBoardPage(scopeKey, column.pageSize));
  }, [column.pageSize, scopeKey]);
  const current =
    page.key === scopeKey ? page : firstPullRequestBoardPage(scopeKey, column.pageSize);

  const targets = useMemo(
    () =>
      environmentQueries.flatMap(({ environmentId, projectIds }) => {
        const cursors = current.cursors?.[environmentId];
        // A continuation asks the servers that said where to carry on from, plus the ones with
        // more to give and no cursor to give it from. The rest have run out, and re-reading them
        // would answer with the rows already on screen.
        if (
          current.cursors !== null &&
          cursors === undefined &&
          !current.regrown.includes(environmentId)
        ) {
          return [];
        }
        return [
          {
            environmentId,
            input: column.input({
              ...scope,
              ...(projectIds ? { projectIds } : {}),
              limit: current.size,
              ...(cursors === undefined ? {} : { cursors }),
            }),
          },
        ];
      }),
    [column, current.cursors, current.regrown, current.size, environmentQueries, scope],
  );
  const query = usePullRequestList(targets);

  // A continuation is a slice, so the rows already read stay and the slice lands under them. Only
  // a whole-page answer replaces the order, which is what a refresh is.
  const [held, setHeld] = useState<{
    key: string;
    entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  } | null>(null);
  const answer = query.data;
  useEffect(() => {
    if (answer === null) return;
    setHeld((previous) => {
      if (previous === null || previous.key !== scopeKey) {
        return { key: scopeKey, entries: answer.entries };
      }
      if (current.cursors === null) return { key: scopeKey, entries: answer.entries };
      return {
        key: scopeKey,
        entries: appendPullRequestBoardEntries(previous.entries, answer.entries),
      };
    });
  }, [answer, current.cursors, scopeKey]);

  const entries = held?.key === scopeKey ? held.entries : (answer?.entries ?? []);

  const refresh = useCallback(() => {
    // A cursored read only re-reads its own slice, so the rows loaded before it would never see a
    // merge or a close. One page long enough to cover them all brings the whole column up to date.
    if (current.cursors === null) {
      query.refresh();
      return;
    }
    setPage({
      key: scopeKey,
      size: Math.min(
        Math.max(current.size, Math.ceil(entries.length / column.pageSize) * column.pageSize),
        MAX_PULL_REQUEST_BOARD_PAGE_SIZE,
      ),
      cursors: null,
      regrown: [],
    });
  }, [column.pageSize, current.cursors, current.size, entries.length, query, scopeKey]);
  const appliedRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    refresh();
  }, [refresh, refreshToken]);

  const truncated = answer?.truncated === true;
  const canLoadMore = canLoadMorePullRequestBoardColumn({
    truncated,
    hasCursors: Object.keys(answer?.nextCursors ?? {}).length > 0,
    size: current.size,
  });
  const loadMore = () => {
    if (answer === null || !canLoadMore) return;
    setPage(nextPullRequestBoardPage(current, answer, column.pageSize));
  };

  return {
    entries,
    count: formatPullRequestBoardCount({
      ...(answer?.totalCount === undefined ? {} : { totalCount: answer.totalCount }),
      loaded: entries.length,
      truncated,
    }),
    error: query.error,
    // A continuation is keyed as its own read, so the answer is null again while it travels —
    // the rows already held are what the column keeps showing, and only a column with none of
    // them is actually loading for the first time.
    firstLoad: query.isPending && answer === null && entries.length === 0,
    loadingMore: query.isPending && entries.length > 0,
    canLoadMore,
    loadMore,
    retry: refresh,
  };
}
