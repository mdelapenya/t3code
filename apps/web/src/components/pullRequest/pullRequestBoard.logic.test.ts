import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendPullRequestBoardEntries,
  canLoadMorePullRequestBoardColumn,
  firstPullRequestBoardPage,
  formatPullRequestBoardCount,
  MAX_PULL_REQUEST_BOARD_PAGE_SIZE,
  nextPullRequestBoardPage,
  PULL_REQUEST_BOARD_COLUMNS,
  PULL_REQUEST_BOARD_PAGE_SIZE,
  pullRequestBoardScopeKey,
} from "./pullRequestBoard.logic";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

const column = (id: string) => {
  const found = PULL_REQUEST_BOARD_COLUMNS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no column ${id}`);
  return found;
};

const SCOPE = { involvement: "all", limit: PULL_REQUEST_BOARD_PAGE_SIZE } as const;

function entry(overrides: { number: number; updatedAt?: string }): EnvironmentPullRequestEntry {
  return {
    environmentId: "env-1" as EnvironmentId,
    provider: "github",
    host: "github.com",
    projectId: "project-1" as ProjectId,
    projectTitle: "t3code",
    repository: "pingdotgg/t3code",
    title: `Pull request ${overrides.number}`,
    url: `https://github.com/pingdotgg/t3code/pull/${overrides.number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/branch-${overrides.number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    number: overrides.number,
  } as EnvironmentPullRequestEntry;
}

describe("the board's columns", () => {
  it("asks each stage's own question", () => {
    expect(column("draft").input(SCOPE)).toMatchObject({
      state: "open",
      filters: { draft: "only" },
    });
    expect(column("in-review").input(SCOPE)).toMatchObject({
      state: "open",
      filters: { draft: "hide", review: "not-approved" },
    });
    expect(column("approved").input(SCOPE)).toMatchObject({
      state: "open",
      filters: { draft: "hide", review: "approved" },
    });
    const merged = column("merged").input(SCOPE);
    expect(merged.state).toBe("merged");
    // Merged rows are merged; narrowing them by review would only ever subtract.
    expect(merged.filters).toBeUndefined();
  });

  it("carries the board's shared scope into every column", () => {
    const input = column("approved").input({
      involvement: "reviewing",
      projectId: "project-1" as ProjectId,
      host: "github.com",
      query: "parser",
      limit: 50,
      cursors: { "github.com pingdotgg/t3code": "cursor-1" },
    });
    expect(input).toEqual({
      state: "open",
      involvement: "reviewing",
      limit: 50,
      projectId: "project-1",
      host: "github.com",
      filters: { draft: "hide", review: "approved" },
      query: "parser",
      cursors: { "github.com pingdotgg/t3code": "cursor-1" },
    });
  });

  it("leaves an absent scope field out rather than sending it empty", () => {
    expect(Object.keys(column("draft").input(SCOPE))).toEqual([
      "state",
      "involvement",
      "limit",
      "filters",
    ]);
  });
});

describe("what a column header counts", () => {
  it("prefers the host's own total", () => {
    expect(formatPullRequestBoardCount({ totalCount: 132, loaded: 25, truncated: true })).toBe(
      "132",
    );
  });

  it("counts the rows loaded when no host reported a total", () => {
    expect(formatPullRequestBoardCount({ loaded: 7, truncated: false })).toBe("7");
  });

  it("says the rows loaded are not all of them", () => {
    expect(formatPullRequestBoardCount({ loaded: 25, truncated: true })).toBe("25+");
  });

  it("keeps a total of zero rather than reading it as absent", () => {
    expect(formatPullRequestBoardCount({ totalCount: 0, loaded: 4, truncated: true })).toBe("0");
  });
});

describe("paging one column", () => {
  const page = firstPullRequestBoardPage("scope", PULL_REQUEST_BOARD_PAGE_SIZE);
  const cursors = { "env-1": { "github.com acme/web": "cursor-1" } };

  it("carries on from the cursors without growing the page", () => {
    expect(
      nextPullRequestBoardPage(
        page,
        { nextCursors: cursors, truncatedEnvironments: ["env-1"] },
        PULL_REQUEST_BOARD_PAGE_SIZE,
      ),
    ).toEqual({ key: "scope", size: PULL_REQUEST_BOARD_PAGE_SIZE, cursors, regrown: [] });
  });

  it("grows the page for a server that has more but no cursor to reach it by", () => {
    expect(
      nextPullRequestBoardPage(
        page,
        { nextCursors: cursors, truncatedEnvironments: ["env-1", "env-2"] },
        PULL_REQUEST_BOARD_PAGE_SIZE,
      ),
    ).toEqual({
      key: "scope",
      size: PULL_REQUEST_BOARD_PAGE_SIZE * 2,
      cursors,
      regrown: ["env-2"],
    });
  });

  it("grows the page when nothing said where to carry on from", () => {
    expect(
      nextPullRequestBoardPage(
        page,
        { nextCursors: {}, truncatedEnvironments: ["env-1"] },
        PULL_REQUEST_BOARD_PAGE_SIZE,
      ),
    ).toEqual({
      key: "scope",
      size: PULL_REQUEST_BOARD_PAGE_SIZE * 2,
      cursors: null,
      regrown: [],
    });
  });

  it("never grows past the cap, where the listing would refuse the read", () => {
    const grown = { ...page, size: MAX_PULL_REQUEST_BOARD_PAGE_SIZE };
    expect(
      nextPullRequestBoardPage(grown, { nextCursors: {}, truncatedEnvironments: [] }, 25).size,
    ).toBe(MAX_PULL_REQUEST_BOARD_PAGE_SIZE);
  });

  it("offers a further page only while one is reachable", () => {
    expect(
      canLoadMorePullRequestBoardColumn({ truncated: false, hasCursors: true, size: 25 }),
    ).toBe(false);
    expect(
      canLoadMorePullRequestBoardColumn({ truncated: true, hasCursors: false, size: 25 }),
    ).toBe(true);
    // At the cap only a continuation can reach the rest, so growth alone stops offering.
    expect(
      canLoadMorePullRequestBoardColumn({
        truncated: true,
        hasCursors: false,
        size: MAX_PULL_REQUEST_BOARD_PAGE_SIZE,
      }),
    ).toBe(false);
    expect(
      canLoadMorePullRequestBoardColumn({
        truncated: true,
        hasCursors: true,
        size: MAX_PULL_REQUEST_BOARD_PAGE_SIZE,
      }),
    ).toBe(true);
  });
});

describe("growing a column's rows", () => {
  it("appends only what it does not already hold, newest of the slice first", () => {
    const held = [entry({ number: 1, updatedAt: "2026-08-03T00:00:00Z" })];
    const arrived = [
      entry({ number: 2, updatedAt: "2026-08-01T00:00:00Z" }),
      entry({ number: 1, updatedAt: "2026-08-03T00:00:00Z" }),
      entry({ number: 3, updatedAt: "2026-08-02T00:00:00Z" }),
    ];
    expect(appendPullRequestBoardEntries(held, arrived).map((row) => row.number)).toEqual([
      1, 3, 2,
    ]);
  });

  it("holds on to the same rows when a slice brings nothing new", () => {
    const held = [entry({ number: 1 })];
    expect(appendPullRequestBoardEntries(held, [entry({ number: 1 })])).toBe(held);
  });
});

describe("what makes two boards different questions", () => {
  it("changes with the search, and with nothing else on its own", () => {
    const base = { environmentKey: "env-1", involvement: "all" } as const;
    expect(pullRequestBoardScopeKey(base)).toBe(pullRequestBoardScopeKey({ ...base }));
    expect(pullRequestBoardScopeKey({ ...base, query: "parser" })).not.toBe(
      pullRequestBoardScopeKey(base),
    );
    expect(pullRequestBoardScopeKey({ ...base, host: "github.com" })).not.toBe(
      pullRequestBoardScopeKey(base),
    );
  });
});
