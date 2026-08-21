import { describe, it, expect } from "vite-plus/test";
import {
  isSbxSshHostname,
  sbxSandboxNameFromHostname,
  sbxSshHostnameForSandbox,
  validateSbxSandboxName,
} from "@t3tools/contracts";

import {
  buildSbxCreateArgs,
  buildSbxInstallCommands,
  buildSbxRemoveArgs,
  formatSbxOutputTail,
  parseSbxListOutput,
  parseSbxVersionOutput,
  resolveSbxInstallMethod,
} from "./DesktopSbxCli.ts";

describe("validateSbxSandboxName", () => {
  it("accepts names matching the CLI rules", () => {
    expect(validateSbxSandboxName("t3sbx")).toBeNull();
    expect(validateSbxSandboxName("my-project.2")).toBeNull();
    expect(validateSbxSandboxName("42crunch")).toBeNull();
  });

  it("rejects short, reserved, and malformed names", () => {
    expect(validateSbxSandboxName("a")).not.toBeNull();
    expect(validateSbxSandboxName(" ")).not.toBeNull();
    expect(validateSbxSandboxName("default")).not.toBeNull();
    expect(validateSbxSandboxName("Default")).not.toBeNull();
    expect(validateSbxSandboxName("-leading")).not.toBeNull();
    expect(validateSbxSandboxName(".leading")).not.toBeNull();
    expect(validateSbxSandboxName("has space")).not.toBeNull();
    expect(validateSbxSandboxName("has_underscore")).not.toBeNull();
  });
});

describe("sbx SSH hostname mapping", () => {
  it("maps sandbox names to .sbx hostnames and back", () => {
    expect(sbxSshHostnameForSandbox("t3sbx")).toBe("t3sbx.sbx");
    expect(sbxSandboxNameFromHostname("t3sbx.sbx")).toBe("t3sbx");
    expect(isSbxSshHostname("t3sbx.sbx")).toBe(true);
  });

  it("does not treat non-sandbox hosts as sandboxes", () => {
    expect(isSbxSshHostname("devbox.example.com")).toBe(false);
    expect(isSbxSshHostname(".sbx")).toBe(false);
    expect(sbxSandboxNameFromHostname("devbox")).toBeNull();
  });
});

describe("buildSbxCreateArgs", () => {
  it("orders flags before the agent and workspace positionals", () => {
    expect(
      buildSbxCreateArgs({
        name: "t3sbx",
        agent: "claude",
        workspacePath: "/Users/me/project",
        kits: ["docker.io/sbx/t3code-kit:latest", "docker.io/sbx/github-ssh-kit:latest"],
      }),
    ).toEqual([
      "create",
      "--name",
      "t3sbx",
      "--kit",
      "docker.io/sbx/t3code-kit:latest",
      "--kit",
      "docker.io/sbx/github-ssh-kit:latest",
      "claude",
      "/Users/me/project",
    ]);
  });

  it("omits the workspace positional when none is given", () => {
    expect(
      buildSbxCreateArgs({ name: "t3sbx", agent: "shell", workspacePath: null, kits: [] }),
    ).toEqual(["create", "--name", "t3sbx", "shell"]);
  });
});

describe("buildSbxRemoveArgs", () => {
  it("forces removal for non-interactive use", () => {
    expect(buildSbxRemoveArgs("t3sbx")).toEqual(["rm", "--force", "t3sbx"]);
  });
});

describe("parseSbxListOutput", () => {
  it("parses the ls --json row shape", () => {
    const stdout = JSON.stringify([
      {
        name: "t3sbx",
        id: "",
        agent: "claude",
        status: "running",
        workspaces: ["/Users/me/project"],
      },
      { name: "porritas", id: "", agent: "shell", status: "stopped" },
    ]);
    expect(parseSbxListOutput(stdout)).toEqual([
      {
        name: "t3sbx",
        agent: "claude",
        status: "running",
        workspaces: ["/Users/me/project"],
      },
      { name: "porritas", agent: "shell", status: "stopped", workspaces: [] },
    ]);
  });

  it("parses the {sandboxes: [...]} wrapper emitted by other sbx releases", () => {
    const stdout = JSON.stringify(
      {
        sandboxes: [
          {
            name: "t3sbx",
            id: "",
            agent: "claude",
            status: "running",
            workspaces: ["/Users/me/project"],
          },
        ],
      },
      null,
      2,
    );
    expect(parseSbxListOutput(stdout)).toEqual([
      {
        name: "t3sbx",
        agent: "claude",
        status: "running",
        workspaces: ["/Users/me/project"],
      },
    ]);
  });

  it("returns an empty list for an empty JSON document", () => {
    expect(parseSbxListOutput("[]")).toEqual([]);
    expect(parseSbxListOutput('{"sandboxes": []}')).toEqual([]);
  });

  it("drops rows without a usable name instead of failing the listing", () => {
    const stdout = JSON.stringify([{ id: "sbx_123" }, { name: "kept" }]);
    expect(parseSbxListOutput(stdout)).toEqual([
      { name: "kept", agent: null, status: null, workspaces: [] },
    ]);
  });

  it("returns null for non-JSON and unrecognized shapes", () => {
    expect(parseSbxListOutput("No sandboxes found.")).toBeNull();
    expect(parseSbxListOutput('{"name":"t3sbx"}')).toBeNull();
  });
});

describe("parseSbxVersionOutput", () => {
  it("extracts the version token from the human line", () => {
    expect(
      parseSbxVersionOutput(
        "sbx version: v0.39.0-rc1-306-g2d47cb3ed 2d47cb3edf03d590598ef90d64bf21e471586adf\n",
      ),
    ).toBe("v0.39.0-rc1-306-g2d47cb3ed");
    expect(parseSbxVersionOutput("\nsbx version 0.4.2\ncommit abc\n")).toBe("0.4.2");
  });

  it("falls back to the first non-empty line when no token matches", () => {
    expect(parseSbxVersionOutput("development build\n")).toBe("development build");
  });

  it("returns null for empty output", () => {
    expect(parseSbxVersionOutput("\n  \n")).toBeNull();
  });
});

describe("install method resolution", () => {
  it("offers homebrew on macOS only when brew is present", () => {
    expect(resolveSbxInstallMethod({ platform: "darwin", brewAvailable: true })).toBe("homebrew");
    expect(resolveSbxInstallMethod({ platform: "darwin", brewAvailable: false })).toBe("manual");
  });

  it("offers winget on Windows and manual elsewhere", () => {
    expect(resolveSbxInstallMethod({ platform: "win32", brewAvailable: false })).toBe("winget");
    expect(resolveSbxInstallMethod({ platform: "linux", brewAvailable: true })).toBe("manual");
  });

  it("builds the trusted install command sequence per method", () => {
    expect(buildSbxInstallCommands("homebrew")).toEqual([
      { command: "brew", args: ["trust", "docker/tap"] },
      { command: "brew", args: ["install", "docker/tap/sbx"] },
    ]);
    expect(buildSbxInstallCommands("winget")).toEqual([
      { command: "winget", args: ["install", "-h", "Docker.sbx"] },
    ]);
    expect(buildSbxInstallCommands("manual")).toEqual([]);
  });
});

describe("formatSbxOutputTail", () => {
  it("keeps the last lines across stdout and stderr", () => {
    const tail = formatSbxOutputTail({
      stdout: Array.from({ length: 10 }, (_, index) => `out ${index}`).join("\n"),
      stderr: "Error: sandbox name already in use",
    });
    expect(tail).toContain("Error: sandbox name already in use");
    expect(tail).not.toContain("out 0");
  });
});
