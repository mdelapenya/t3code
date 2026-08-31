import type {
  ProjectId,
  PullRequestInvolvement,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListInput,
  PullRequestListState,
} from "@t3tools/contracts";

import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

/**
 * The board reads the same listing the flat list does, four times over: one read per review
 * stage, each with its own filters, its own continuation and its own count. Partitioning one
 * feed client-side could not do it — the feed is a page of the newest rows, so a stage whose
 * rows are all older than that page would read as empty — and only a per-stage read can carry
 * the host's own total for the stage.
 */
export type PullRequestBoardColumnId = "draft" | "in-review" | "approved" | "merged";

/**
 * What the whole board is looking at. Every column asks its own question inside this scope, so
 * the route's involvement, host, project scope and search all keep working across the board.
 */
export interface PullRequestBoardScope {
  readonly involvement: PullRequestInvolvement;
  readonly projectId?: ProjectId | undefined;
  /** The projects one server is asked about, where the route spread them across servers. */
  readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  readonly host?: string | undefined;
  /** The words left after the typed qualifiers, handed to the hosts to match themselves. */
  readonly query?: string | undefined;
  /** Rows per repository this read asks for, which a grown page raises. */
  readonly limit: number;
  readonly cursors?: PullRequestListCursors | undefined;
}

export interface PullRequestBoardColumn {
  readonly id: PullRequestBoardColumnId;
  readonly label: string;
  /** Rows per repository a first page asks for, and the step each further page grows by. */
  readonly pageSize: number;
  /** The listing this column is, within the board's shared scope. */
  readonly input: (scope: PullRequestBoardScope) => PullRequestListInput;
}

/**
 * A column is a glance, not a feed: four of these are on screen at once, so each asks for a
 * quarter of what the flat list would and grows on request.
 */
export const PULL_REQUEST_BOARD_PAGE_SIZE = 25;
/** The ceiling the listing itself enforces is 500; a board column stops well short of it. */
export const MAX_PULL_REQUEST_BOARD_PAGE_SIZE = 200;

const columnInput =
  (state: PullRequestListState, filters?: PullRequestListFilters) =>
  (scope: PullRequestBoardScope): PullRequestListInput => ({
    state,
    involvement: scope.involvement,
    limit: scope.limit,
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.projectIds ? { projectIds: scope.projectIds } : {}),
    ...(scope.host ? { host: scope.host } : {}),
    ...(filters === undefined ? {} : { filters }),
    ...(scope.query ? { query: scope.query } : {}),
    ...(scope.cursors === undefined ? {} : { cursors: scope.cursors }),
  });

/**
 * The stages, left to right, in the order work moves through them. "In review" is everything
 * open, non-draft and not yet approved — sent and waiting is the same stage to a reader, so
 * GitHub's `-review:approved` is one column rather than two.
 */
export const PULL_REQUEST_BOARD_COLUMNS: ReadonlyArray<PullRequestBoardColumn> = [
  {
    id: "draft",
    label: "Draft",
    pageSize: PULL_REQUEST_BOARD_PAGE_SIZE,
    input: columnInput("open", { draft: "only" }),
  },
  {
    id: "in-review",
    label: "In review",
    pageSize: PULL_REQUEST_BOARD_PAGE_SIZE,
    input: columnInput("open", { draft: "hide", review: "not-approved" }),
  },
  {
    id: "approved",
    label: "Approved",
    pageSize: PULL_REQUEST_BOARD_PAGE_SIZE,
    input: columnInput("open", { draft: "hide", review: "approved" }),
  },
  {
    id: "merged",
    label: "Recently merged",
    pageSize: PULL_REQUEST_BOARD_PAGE_SIZE,
    input: columnInput("merged"),
  },
];

/**
 * What the column header says beside its name. The hosts' own total wherever they reported one,
 * so a column shows how much work is in that stage rather than how much of it has been paged in;
 * without one, the rows loaded, marked `+` while the host still has more.
 */
export function formatPullRequestBoardCount(answer: {
  readonly totalCount?: number | undefined;
  readonly loaded: number;
  readonly truncated: boolean;
}): string {
  if (answer.totalCount !== undefined) return String(answer.totalCount);
  return answer.truncated ? `${answer.loaded}+` : String(answer.loaded);
}

/**
 * One column's paging, the same shape the flat list keeps: where each server carries on from, and
 * the ones that can only be grown into. Keyed by the scope it belongs to, so a page from before a
 * host or involvement switch is never sent with the question that replaced it.
 */
export interface PullRequestBoardPage {
  readonly key: string;
  readonly size: number;
  readonly cursors: Readonly<Record<string, PullRequestListCursors>> | null;
  /** Servers with more rows and no cursor to reach them by; they are read again, larger. */
  readonly regrown: ReadonlyArray<string>;
}

export const firstPullRequestBoardPage = (key: string, pageSize: number): PullRequestBoardPage => ({
  key,
  size: pageSize,
  cursors: null,
  regrown: [],
});

/**
 * The page after this one. A continuation carries on from the cursors the answer gave and leaves
 * the page size alone; only the servers that said "more" without saying where grow, and with no
 * cursors at all growing the page is the only way on.
 */
export function nextPullRequestBoardPage(
  page: PullRequestBoardPage,
  answer: {
    readonly nextCursors: Readonly<Record<string, PullRequestListCursors>>;
    readonly truncatedEnvironments: ReadonlyArray<string>;
  },
  pageSize: number,
): PullRequestBoardPage {
  const regrown = answer.truncatedEnvironments.filter(
    (environmentId) => answer.nextCursors[environmentId] === undefined,
  );
  const grown = Math.min(page.size + pageSize, MAX_PULL_REQUEST_BOARD_PAGE_SIZE);
  if (Object.keys(answer.nextCursors).length > 0) {
    return {
      key: page.key,
      size: regrown.length === 0 ? page.size : grown,
      cursors: answer.nextCursors,
      regrown,
    };
  }
  return { key: page.key, size: grown, cursors: null, regrown: [] };
}

/**
 * Whether the column has a further page to offer. Growth stops at the cap, where asking again
 * would only be refused; a continuation does not grow the page, so the cap does not bind it.
 */
export function canLoadMorePullRequestBoardColumn(state: {
  readonly truncated: boolean;
  readonly hasCursors: boolean;
  readonly size: number;
}): boolean {
  return state.truncated && (state.hasCursors || state.size < MAX_PULL_REQUEST_BOARD_PAGE_SIZE);
}

/**
 * A continuation is a slice, not the column: it says nothing about the rows already read, so what
 * is on screen stays and the slice lands under it, ordered among itself because one repository's
 * next rows can still be newer than another's last.
 */
export function appendPullRequestBoardEntries(
  held: ReadonlyArray<EnvironmentPullRequestEntry>,
  arrived: ReadonlyArray<EnvironmentPullRequestEntry>,
): ReadonlyArray<EnvironmentPullRequestEntry> {
  const keys = new Set(held.map(pullRequestEntryKey));
  const added = arrived.filter((entry) => !keys.has(pullRequestEntryKey(entry)));
  if (added.length === 0) return held;
  return [
    ...held,
    ...added.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ];
}

/**
 * What makes two boards different questions. A column's paging and its accumulated rows are
 * filed under this, so switching host, involvement, scope or search starts every column again
 * rather than continuing one listing into another.
 */
export const pullRequestBoardScopeKey = (scope: {
  readonly environmentKey: string;
  readonly involvement: string;
  readonly projectId?: string | undefined;
  readonly host?: string | undefined;
  readonly query?: string | undefined;
}): string =>
  [
    scope.environmentKey,
    scope.involvement,
    scope.projectId ?? "",
    scope.host ?? "",
    scope.query ?? "",
  ].join(":");
