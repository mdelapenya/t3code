import type { DesktopSbxInstallMethod, DesktopSbxSandbox } from "@t3tools/contracts";

// Pure argv builders and output parsers for the Docker Sandboxes (sbx) CLI.
// Everything that spawns processes lives in DesktopSbxEnvironment; keeping
// this module pure lets the command shapes and parsing be tested without a
// spawner. Cross-surface sbx constants (kits, agents, hostname mapping, name
// validation) live in @t3tools/contracts next to the schemas.

export const buildSbxVersionArgs = (): ReadonlyArray<string> => ["version"];

export const buildSbxListArgs = (): ReadonlyArray<string> => ["ls", "--json"];

export const buildSbxSetupSshArgs = (): ReadonlyArray<string> => ["setup", "ssh"];

export const buildSbxCreateArgs = (input: {
  readonly name: string;
  readonly agent: string;
  readonly workspacePath: string | null;
  readonly kits: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  "create",
  "--name",
  input.name,
  ...input.kits.flatMap((kit) => ["--kit", kit]),
  input.agent,
  ...(input.workspacePath === null ? [] : [input.workspacePath]),
];

export const buildSbxRemoveArgs = (name: string): ReadonlyArray<string> => [
  "rm",
  "--force",
  name,
];

// `sbx version` prints a human block like "sbx version: v0.39.0-rc1-306-g… <commit>".
// Pull out the version-looking token; fall back to the first non-empty line.
export const parseSbxVersionOutput = (stdout: string): string | null => {
  const line = stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return null;
  const versionToken = line.split(/\s+/).find((token) => /^v?\d+\.\d+/u.test(token));
  return versionToken ?? line;
};

// `sbx ls --json` rows are {name, id, agent, status, workspaces?}. The top
// level has changed across sbx releases — a bare array on some, a
// {"sandboxes": [...]} wrapper on others — so accept both. Rows missing a
// usable name are dropped rather than failing the whole listing, and unknown
// fields are ignored.
export const parseSbxListOutput = (stdout: string): ReadonlyArray<DesktopSbxSandbox> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as Record<string, unknown>).sandboxes)
      ? ((parsed as Record<string, unknown>).sandboxes as unknown[])
      : null;
  if (rows === null) return null;

  const sandboxes: DesktopSbxSandbox[] = [];
  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    sandboxes.push({
      name: record.name,
      agent: typeof record.agent === "string" && record.agent.length > 0 ? record.agent : null,
      status:
        typeof record.status === "string" && record.status.length > 0 ? record.status : null,
      workspaces: Array.isArray(record.workspaces)
        ? record.workspaces.filter((workspace): workspace is string => typeof workspace === "string")
        : [],
    });
  }
  return sandboxes;
};

// One-click install support per host platform. Homebrew is sudo-less, and
// winget elevates through a standard UAC consent prompt. The Linux installer
// is `curl | sudo sh`, which a GUI app must not run silently — Linux users get
// copyable commands instead.
export const resolveSbxInstallMethod = (input: {
  readonly platform: NodeJS.Platform;
  readonly brewAvailable: boolean;
}): DesktopSbxInstallMethod => {
  if (input.platform === "darwin" && input.brewAvailable) return "homebrew";
  if (input.platform === "win32") return "winget";
  return "manual";
};

export interface SbxInstallCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export const buildSbxInstallCommands = (
  method: DesktopSbxInstallMethod,
): ReadonlyArray<SbxInstallCommand> => {
  switch (method) {
    case "homebrew":
      return [
        { command: "brew", args: ["trust", "docker/tap"] },
        { command: "brew", args: ["install", "docker/tap/sbx"] },
      ];
    case "winget":
      return [{ command: "winget", args: ["install", "-h", "Docker.sbx"] }];
    case "manual":
      return [];
  }
};

// Shown as copyable text when one-click install is unavailable, and as
// reference alongside the button when it is. Source of truth:
// https://docs.docker.com/ai/sandboxes/install/
export const sbxManualInstallCommands = (platform: NodeJS.Platform): ReadonlyArray<string> => {
  switch (platform) {
    case "darwin":
      return ["brew trust docker/tap", "brew install docker/tap/sbx"];
    case "win32":
      return ["winget install -h Docker.sbx"];
    default:
      return ["curl -fsSL https://get.docker.com | sudo SBX=1 sh"];
  }
};

// Compact tail of a failed command's output for error messages: prefer
// stderr, cap length, and collapse the whitespace noise CLIs print.
export const formatSbxOutputTail = (output: {
  readonly stdout: string;
  readonly stderr: string;
}): string => {
  const combined = `${output.stdout}\n${output.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return combined.slice(-6).join("\n").slice(-600);
};
