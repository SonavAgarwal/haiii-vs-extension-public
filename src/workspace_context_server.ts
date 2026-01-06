import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "mcp-zod";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { WORKSPACE_FILE_EXCLUDES, MAX_WORKSPACE_FILES } from "./consts";
import { BaseMcpHttpServer } from "./mcp_base";
import { WORKSPACE_CONTEXT_SERVER_NAME } from "@voice-coding/shared-types";

const MAX_FILE_PREVIEW_CHARS = 20_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_SCAN_CHARS = 200_000;
const SNIPPET_RADIUS = 80;
const MAX_DIAGNOSTICS = 50;

type SearchMatch = {
    filePath: string;
    line: number;
    snippet: string;
};

export class WorkspaceContextServer extends BaseMcpHttpServer {
    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(WORKSPACE_CONTEXT_SERVER_NAME, log, context);
    }

    protected createMcpServer() {
        const server = new McpServer(
            { name: WORKSPACE_CONTEXT_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );

        server.registerTool(
            "searchAllFiles",
            {
                description:
                    "Search across workspace files for matches to a regular expression using ripgrep.",
                inputSchema: z.object({
                    pattern: z
                        .string()
                        .min(1)
                        .describe("Regular expression pattern"),
                    flags: z
                        .string()
                        .optional()
                        .describe(
                            'Optional regex flags (supported: "i" for case-insensitive, "m" for multi-line).'
                        ),
                }).shape,
            },
            async ({ pattern, flags }: { pattern: string; flags?: string }) => {
                this.log(
                    `workspace-context searchAllFiles called with pattern=${pattern} flags=${
                        flags ?? ""
                    }`
                );
                const roots = vscode.workspace.workspaceFolders;
                if (!roots || roots.length === 0) {
                    return {
                        content: [
                            { type: "text", text: "No workspace is open." },
                        ],
                    };
                }

                let parsedFlags: ParsedFlags;
                try {
                    parsedFlags = parseRegexFlags(flags);
                } catch (err) {
                    const msg = `Invalid regular expression flags: ${String(
                        err
                    )}`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                let matches: SearchMatch[];
                try {
                    matches = await searchWithRipgrep({
                        pattern,
                        flags: parsedFlags,
                        roots,
                    });
                } catch (err) {
                    this.log(
                        `ripgrep search failed (${String(
                            err
                        )}); falling back to manual scan.`
                    );
                    matches = await this.searchManually(pattern, parsedFlags);
                }

                if (matches.length === 0) {
                    const msg = `No matches found for /${pattern}/${
                        flags ?? ""
                    }.`;
                    this.log(msg);
                    return {
                        content: [{ type: "text", text: msg }],
                    };
                }

                const lines = [
                    `Found ${matches.length} match(es) for /${pattern}/${
                        flags ?? ""
                    }:`,
                    ...matches.map(
                        (match) =>
                            `- ${match.filePath} (line ${match.line})\n  ${match.snippet}`
                    ),
                ];
                const text = lines.join("\n");
                this.log(
                    `workspace-context searchAllFiles returning ${matches.length} result(s)`
                );
                for (const line of lines) {
                    this.log(`  - ${line}`); // log each result line for visibility
                }
                return {
                    content: [{ type: "text", text }],
                };
            }
        );

        server.registerTool(
            "readFile",
            {
                description:
                    "Read any file by absolute path, relative path, or file:// URI.",
                inputSchema: z.object({
                    filePath: z
                        .string()
                        .describe(
                            "Absolute path, relative path, or file:// URI"
                        ),
                }).shape,
            },
            async ({ filePath }: { filePath: string }) => {
                this.log(`workspace-context readFile called with ${filePath}`);
                try {
                    const text = await this.readFileContents(filePath);
                    const limited =
                        text.length > MAX_FILE_PREVIEW_CHARS
                            ? `${text.slice(
                                  0,
                                  MAX_FILE_PREVIEW_CHARS
                              )}\n\n... (truncated, total ${text.length} chars)`
                            : text;
                    this.log(
                        `workspace-context readFile succeeded for ${filePath} with ${limited.length} chars returned`
                    );
                    return {
                        content: [{ type: "text", text: limited }],
                    };
                } catch (err) {
                    const msg = `Failed to read ${filePath}: ${String(err)}`;
                    this.log(msg);
                    return {
                        content: [{ type: "text", text: msg }],
                    };
                }
            }
        );

        server.registerTool(
            "getErrors",
            {
                description:
                    "Fetch errors for files in the workspace. Set currentFileOnly to true to scope to the active file.",
                inputSchema: z.object({
                    currentFileOnly: z
                        .boolean()
                        .optional()
                        .describe(
                            "Set true to only return errors for the active file."
                        ),
                }).shape,
            },
            async ({
                currentFileOnly = false,
            }: {
                currentFileOnly?: boolean;
            }) => {
                this.log(
                    `workspace-context getErrors called (currentFileOnly=${currentFileOnly})`
                );

                const diagnoses = collectDiagnostics(currentFileOnly);
                if (diagnoses.length === 0) {
                    const msg = "No errors available.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const limited = diagnoses.slice(0, MAX_DIAGNOSTICS);
                const lines = limited.map((diag) => {
                    const codePart = diag.code ? ` [${diag.code}]` : "";
                    return `${diag.file}:${diag.line}:${diag.character} (${diag.severity})${codePart}\n  ${diag.message}`;
                });

                const extra =
                    diagnoses.length > MAX_DIAGNOSTICS
                        ? `\n... ${
                              diagnoses.length - MAX_DIAGNOSTICS
                          } more errors truncated.`
                        : "";
                const text = `${lines.join("\n")}${extra}`;
                this.log(
                    `workspace-context getErrors returning ${limited.length} of ${diagnoses.length} error(s)`
                );
                for (const line of lines) {
                    this.log(`  - ${line}`); // log each error line for visibility
                }
                return {
                    content: [{ type: "text", text }],
                };
            }
        );

        return server;
    }

    private async readWorkspaceFile(uri: vscode.Uri): Promise<string> {
        const buf = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(buf).toString("utf8");
    }

    private async readFileContents(filePath: string): Promise<string> {
        if (filePath.startsWith("file://")) {
            const uri = vscode.Uri.parse(filePath);
            const buf = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(buf).toString("utf8");
        }

        const resolved = this.resolvePath(filePath);
        const buf = await fs.readFile(resolved, "utf8");
        return buf;
    }

    private resolvePath(filePath: string): string {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            return path.resolve(workspaceRoot, filePath);
        }
        return path.resolve(filePath);
    }

    private async searchManually(
        pattern: string,
        flags: ParsedFlags
    ): Promise<SearchMatch[]> {
        const files = await vscode.workspace.findFiles(
            "**/*",
            WORKSPACE_FILE_EXCLUDES,
            MAX_WORKSPACE_FILES
        );

        if (files.length === 0) {
            return [];
        }

        const regexFlags =
            "g" +
            (flags.isCaseSensitive ? "" : "i") +
            (flags.isMultiline ? "m" : "");
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, regexFlags);
        } catch (err) {
            this.log(`Fallback regex compilation failed: ${String(err)}`);
            return [];
        }

        const matches: SearchMatch[] = [];
        for (const uri of files) {
            if (matches.length >= MAX_SEARCH_RESULTS) break;
            try {
                const text = await this.readWorkspaceFile(uri);
                const limited =
                    text.length > MAX_SCAN_CHARS
                        ? text.slice(0, MAX_SCAN_CHARS)
                        : text;
                const fileRegex = new RegExp(regex.source, regexFlags);
                let match: RegExpExecArray | null;
                while (
                    matches.length < MAX_SEARCH_RESULTS &&
                    (match = fileRegex.exec(limited)) !== null
                ) {
                    const matchText = match[0] ?? "";
                    matches.push({
                        filePath: uri.fsPath,
                        line: lineNumberAt(limited, match.index),
                        snippet: buildSnippet(
                            limited,
                            match.index,
                            matchText.length
                        ),
                    });
                    if (matchText.length === 0) {
                        fileRegex.lastIndex += 1;
                    }
                }
            } catch (err) {
                this.log(`Manual scan skipping ${uri.fsPath}: ${String(err)}`);
            }
        }

        return matches;
    }
}

type ParsedFlags = {
    isCaseSensitive: boolean;
    isMultiline: boolean;
};

function parseRegexFlags(flags?: string): ParsedFlags {
    if (!flags) {
        return {
            isCaseSensitive: true,
            isMultiline: false,
        };
    }

    const unique = new Set(flags.split(""));
    const supported = ["i", "m"];
    for (const flag of unique) {
        if (!supported.includes(flag)) {
            throw new Error(
                `Unsupported flag "${flag}". Supported: ${supported.join(", ")}`
            );
        }
    }

    return {
        isCaseSensitive: !unique.has("i"),
        isMultiline: unique.has("m"),
    };
}

function sanitizeSnippet(snippet: string): string {
    return snippet.replace(/\s+/g, " ").trim();
}

function buildSnippet(
    text: string,
    matchIndex: number,
    matchLength: number
): string {
    if (!text) return "";
    if (matchIndex < 0) {
        return sanitizeSnippet(text.slice(0, SNIPPET_RADIUS * 2));
    }
    const first = Math.max(0, matchIndex - SNIPPET_RADIUS);
    const last = Math.min(
        text.length,
        matchIndex + matchLength + SNIPPET_RADIUS
    );
    return sanitizeSnippet(text.slice(first, last));
}

function lineNumberAt(text: string, index: number): number {
    if (index <= 0) return 1;
    let line = 1;
    const limit = Math.min(index, text.length);
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) line++;
    }
    return line;
}

type DiagnosticEntry = {
    file: string;
    line: number;
    character: number;
    severity: string;
    message: string;
    code?: string;
};

function collectDiagnostics(currentFileOnly: boolean): DiagnosticEntry[] {
    const diagnostics: DiagnosticEntry[] = [];

    if (currentFileOnly) {
        const active = vscode.window.activeTextEditor;
        if (!active) {
            return diagnostics;
        }
        const entries = vscode.languages.getDiagnostics(active.document.uri);
        pushDiagnosticsForUri(active.document.uri, entries, diagnostics);
        return diagnostics;
    }

    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
        pushDiagnosticsForUri(uri, entries, diagnostics);
    }

    return diagnostics;
}

function pushDiagnosticsForUri(
    uri: vscode.Uri,
    entries: readonly vscode.Diagnostic[],
    acc: DiagnosticEntry[]
): void {
    if (!entries || entries.length === 0) return;
    const relative = vscode.workspace.asRelativePath(uri, false);
    const file = relative && !relative.startsWith("..") ? relative : uri.fsPath;
    for (const diag of entries) {
        acc.push({
            file,
            line: diag.range.start.line + 1,
            character: diag.range.start.character + 1,
            severity: diagnosticSeverityLabel(diag.severity),
            message: normalizeDiagnosticMessage(diag.message),
            code: diagnosticCodeToString(diag.code),
        });
    }
}

function diagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return "error";
        case vscode.DiagnosticSeverity.Warning:
            return "warning";
        case vscode.DiagnosticSeverity.Information:
            return "info";
        case vscode.DiagnosticSeverity.Hint:
            return "hint";
        default:
            return "unknown";
    }
}

function diagnosticCodeToString(
    code: string | number | { value: string | number } | undefined
): string | undefined {
    if (code === undefined) return undefined;
    if (typeof code === "string" || typeof code === "number") {
        return String(code);
    }
    if (typeof code.value === "string" || typeof code.value === "number") {
        return String(code.value);
    }
    return undefined;
}

function normalizeDiagnosticMessage(message: string): string {
    return message.replace(/\s+/g, " ").trim();
}

async function searchWithRipgrep(opts: {
    pattern: string;
    flags: ParsedFlags;
    roots: readonly vscode.WorkspaceFolder[];
}): Promise<SearchMatch[]> {
    const { pattern, flags, roots } = opts;
    const rootPaths = roots.map((r) => r.uri.fsPath);
    if (rootPaths.length === 0) {
        return [];
    }

    const args: string[] = [
        "--json",
        "--line-number",
        "--color",
        "never",
        "--max-count",
        String(MAX_SEARCH_RESULTS),
    ];
    if (!flags.isCaseSensitive) args.push("-i");
    if (flags.isMultiline) args.push("-U");

    for (const glob of parseExcludeGlobs(WORKSPACE_FILE_EXCLUDES)) {
        args.push("--glob", `!${glob}`);
    }

    args.push("-e", pattern);
    args.push(...rootPaths);

    return new Promise<SearchMatch[]>((resolve, reject) => {
        const matches: SearchMatch[] = [];
        let stderr = "";
        let buffer = "";

        const child = spawn("rg", args, {
            cwd: rootPaths[0],
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.on("error", (err) => reject(err));

        child.stdout?.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === "match") {
                        const data = parsed.data;
                        const pathText: string | undefined = data?.path?.text;
                        const lineNumber: number | undefined =
                            data?.line_number;
                        const text: string | undefined = data?.lines?.text;
                        if (
                            !pathText ||
                            typeof lineNumber !== "number" ||
                            !text
                        )
                            continue;
                        matches.push({
                            filePath: pathText,
                            line: lineNumber,
                            snippet: sanitizeSnippet(text),
                        });
                        if (matches.length >= MAX_SEARCH_RESULTS) {
                            child.kill();
                            break;
                        }
                    }
                } catch {
                    /* ignore malformed lines */
                }
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });

        child.on("close", (code) => {
            if (matches.length >= MAX_SEARCH_RESULTS) {
                resolve(matches);
                return;
            }
            if (code === 0 || code === 1) {
                resolve(matches);
            } else {
                const err =
                    stderr.trim().length > 0
                        ? new Error(stderr.trim())
                        : new Error(`rg exited with code ${code}`);
                reject(err);
            }
        });
    });
}

function parseExcludeGlobs(pattern: string): string[] {
    const trimmed = pattern.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed
            .slice(1, -1)
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }
    return [trimmed];
}
