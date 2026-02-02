import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fuzzysort from "fuzzysort";
import { z } from "mcp-zod";
import * as path from "node:path";
import * as vscode from "vscode";
import { BaseMcpHttpServer } from "./mcp_base";
import {
    getEffectiveActiveTextDocument,
    getEffectiveActiveTextEditor,
} from "./current_file_tracker";
import { MAX_WORKSPACE_FILES, WORKSPACE_FILE_EXCLUDES } from "./consts";
import { IDE_NAVIGATION_SERVER_NAME } from "@voice-coding/shared-types";

export class IDENavigationServer extends BaseMcpHttpServer {
    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(IDE_NAVIGATION_SERVER_NAME, log, context);
    }

    protected createMcpServer() {
        const server = new McpServer(
            { name: IDE_NAVIGATION_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } },
        );

        server.registerTool(
            "showFile",
            {
                description:
                    "Open a file in the editor and return its contents.",
                inputSchema: z.object({
                    filePath: z.string().describe("URI starting with file://"),
                }).shape,
            },
            async ({ filePath }: { filePath: string }) => {
                this.log(`Tool showFile called with ${filePath}`);
                const resolved = await this.resolveFileUri(filePath);
                if (!resolved) {
                    const msg = `Could not find a workspace file matching ${filePath}`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                try {
                    await vscode.commands.executeCommand(
                        "vscode.open",
                        resolved.uri,
                    );
                    // Read and return file contents
                    const buf = await vscode.workspace.fs.readFile(
                        resolved.uri,
                    );
                    const text = Buffer.from(buf).toString("utf8");
                    const limit = 20000;
                    const fileContent =
                        text.length > limit
                            ? text.slice(0, limit) +
                              `\n\n... (truncated, total ${text.length} chars)`
                            : text;
                    const lines = fileContent
                        .split("\n")
                        .map((line, idx) => `${idx + 1}:${line}`);
                    const header = resolved.isExact
                        ? `File: ${resolved.displayPath}`
                        : `File: ${resolved.displayPath} (closest match for ${filePath})`;
                    const msg = [header, ...lines].join("\n");
                    this.log(
                        `showFile opened and returned ${lines.length} lines`,
                    );
                    return { content: [{ type: "text", text: msg }] };
                } catch (e) {
                    const msg = `Failed to open ${
                        resolved.displayPath
                    }: ${String(e)}`;
                    return { content: [{ type: "text", text: msg }] };
                }
            },
        );

        server.registerTool(
            "showCodeSnippet",
            {
                description:
                    "Scroll to and highlight the matching snippet in the current file. Returns the matched lines with surrounding context.",
                inputSchema: z.object({
                    code: z
                        .string()
                        .min(1)
                        .describe("EXACT snippet to show in the current file."),
                }).shape,
            },
            async ({
                code,
                approximateLineNumber,
            }: {
                code: string;
                approximateLineNumber?: number;
            }) => {
                this.log(
                    `Tool showCodeSnippet called with approx line ${
                        approximateLineNumber ?? "n/a"
                    }`,
                );
                this.log(`Code snippet given (${code.length} chars):\n${code}`);
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open to show code.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const match = this.locateSnippet(
                    doc,
                    code,
                    approximateLineNumber ?? 1,
                );
                if (!match) {
                    const msg = "Snippet not found in current file.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const highlighted = await this.highlightRange(doc, match.range);

                // Return matched lines with context
                const contextRadius = 5;
                const startCtx = Math.max(
                    0,
                    match.startLine - 1 - contextRadius,
                );
                const endCtx = Math.min(
                    doc.lineCount,
                    match.endLine + contextRadius,
                );
                const allLines = doc.getText().split("\n");
                const contextLines = allLines
                    .slice(startCtx, endCtx)
                    .map((line, idx) => `${startCtx + idx + 1}:${line}`);

                const rangeLabel =
                    match.startLine === match.endLine
                        ? `line ${match.startLine}`
                        : `lines ${match.startLine}-${match.endLine}`;
                const header = `${highlighted ? "Highlighted" : "Found"} ${
                    match.matchType
                } match at ${rangeLabel}.`;
                const msg = [header, "", ...contextLines].join("\n");
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            },
        );

        server.registerTool(
            "showLine",
            {
                description:
                    "Scroll the editor to a line in the current file and return surrounding code.",
                inputSchema: z.object({
                    startLine: z
                        .number()
                        .int()
                        .min(1)
                        .describe("Line number to scroll to."),
                    endLine: z.number().int().min(1).optional(),
                }).shape,
            },
            async ({
                startLine,
                endLine,
            }: {
                startLine: number;
                endLine?: number;
            }) => {
                this.log(`Tool showLine called with ${startLine}-${endLine}`);
                const editor = getEffectiveActiveTextEditor();
                if (!editor || editor.document.uri.scheme !== "file") {
                    const msg = "No active file is open to scroll.";
                    return { content: [{ type: "text", text: msg }] };
                }
                const showRange = !!endLine && endLine > startLine;
                const doc = editor.document;
                const clampedLine = Math.max(
                    1,
                    Math.min(startLine, doc.lineCount),
                );
                const zeroLine = clampedLine - 1;
                const zeroCol = 0;
                const startTargetPos = new vscode.Position(zeroLine, zeroCol);
                const clampedEnd = endLine
                    ? Math.max(clampedLine, Math.min(endLine, doc.lineCount))
                    : clampedLine;
                const endTargetPos = showRange
                    ? new vscode.Position(clampedEnd - 1, 0)
                    : startTargetPos;
                const targetRange = new vscode.Range(
                    startTargetPos,
                    endTargetPos,
                );
                try {
                    editor.selection = new vscode.Selection(
                        startTargetPos,
                        startTargetPos,
                    );
                    editor.revealRange(
                        targetRange,
                        showRange
                            ? vscode.TextEditorRevealType.Default
                            : vscode.TextEditorRevealType.InCenter,
                    );

                    // Return surrounding code context
                    const contextRadius = 15;
                    const startCtx = Math.max(
                        0,
                        clampedLine - 1 - contextRadius,
                    );
                    const endCtx = Math.min(
                        doc.lineCount,
                        clampedEnd + contextRadius,
                    );
                    const allLines = doc.getText().split("\n");
                    const contextLines = allLines
                        .slice(startCtx, endCtx)
                        .map((line, idx) => `${startCtx + idx + 1}:${line}`);

                    const rangeLabel =
                        clampedLine === clampedEnd
                            ? `line ${clampedLine}`
                            : `lines ${clampedLine}-${clampedEnd}`;
                    const msg = [
                        `Showing ${rangeLabel} of ${doc.uri.fsPath}:`,
                        "",
                        ...contextLines,
                    ].join("\n");
                    this.log(
                        `showLine returned ${contextLines.length} lines of context`,
                    );
                    return { content: [{ type: "text", text: msg }] };
                } catch (e) {
                    const msg = `Failed to reveal line ${startLine} in ${
                        doc.uri.fsPath
                    }: ${String(e)}`;
                    return { content: [{ type: "text", text: msg }] };
                }
            },
        );

        return server;
    }

    private async resolveFileUri(filePath: string) {
        const candidateUri = this.toUri(filePath);
        const query = candidateUri?.fsPath ?? filePath.trim();
        if (!query) return undefined;

        if (candidateUri && (await this.uriExists(candidateUri))) {
            return {
                uri: candidateUri,
                displayPath: this.toRelativeDisplay(candidateUri.fsPath),
                isExact: true,
            };
        }

        const targets = await this.getWorkspaceFileTargets();
        if (targets.length > 0) {
            const results = fuzzysort.go<WorkspaceFileTarget>(query, targets, {
                limit: 1,
                threshold: -5000,
                keys: ["relativePath", "fullPath"],
            });
            const best = results[0];
            if (best) {
                const bestUri = vscode.Uri.file(best.obj.fullPath);
                const isExactMatch =
                    candidateUri &&
                    this.pathsEqual(bestUri.fsPath, candidateUri.fsPath);
                return {
                    uri: bestUri,
                    displayPath: best.obj.relativePath,
                    isExact: !!isExactMatch,
                };
            }
        }

        if (candidateUri && (await this.uriExists(candidateUri))) {
            return {
                uri: candidateUri,
                displayPath: this.toRelativeDisplay(candidateUri.fsPath),
                isExact: true,
            };
        }

        return undefined;
    }

    private toUri(input: string): vscode.Uri | undefined {
        const trimmed = input.trim();
        if (!trimmed) return undefined;

        if (/^file:\/\//i.test(trimmed)) {
            try {
                const parsed = vscode.Uri.parse(trimmed);
                if (parsed.scheme === "file") {
                    if (parsed.authority) {
                        const normalizedFsPath =
                            process.platform === "win32"
                                ? parsed.fsPath
                                : parsed.fsPath.replace(/^\/{2,}/, "/");
                        return vscode.Uri.file(normalizedFsPath);
                    }
                    return parsed;
                }
            } catch {
                // fall through to other strategies
            }
        }

        if (path.isAbsolute(trimmed)) {
            return vscode.Uri.file(trimmed);
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const joined = path.join(workspaceFolders[0].uri.fsPath, trimmed);
            return vscode.Uri.file(joined);
        }

        return undefined;
    }

    private async uriExists(uri: vscode.Uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    private async getWorkspaceFileTargets(): Promise<WorkspaceFileTarget[]> {
        try {
            const uris = await vscode.workspace.findFiles(
                "**/*",
                WORKSPACE_FILE_EXCLUDES,
                MAX_WORKSPACE_FILES,
            );
            return uris.map((u) => {
                const fsPath = u.fsPath;
                return {
                    fullPath: fsPath,
                    relativePath: this.toRelativeDisplay(fsPath),
                };
            });
        } catch {
            return [];
        }
    }

    private locateSnippet(
        doc: vscode.TextDocument,
        snippet: string,
        lineHint: number,
    ): SnippetMatch | undefined {
        const variants = this.buildSnippetVariants(snippet);
        const text = doc.getText();
        for (const variant of variants) {
            if (!variant) continue;
            const exact = this.findClosestMatch(text, variant, lineHint);
            if (exact) {
                const start = doc.positionAt(exact.index);
                const end = doc.positionAt(exact.index + variant.length);
                const startLine = start.line + 1;
                const endLine =
                    end.character === 0 && end.line > start.line
                        ? end.line
                        : end.line + 1;
                return {
                    range: new vscode.Range(start, end),
                    startLine,
                    endLine,
                    matchType: "exact",
                };
            }
        }

        const fuzzySeed = variants[variants.length - 1] ?? snippet;
        return this.fuzzyFindSnippet(doc, text, fuzzySeed, lineHint);
    }

    private buildSnippetVariants(snippet: string): string[] {
        const variants: string[] = [];
        if (snippet && !variants.includes(snippet)) {
            variants.push(snippet);
        }
        const noCarriage = snippet.replace(/\r\n/g, "\n");
        if (noCarriage && !variants.includes(noCarriage)) {
            variants.push(noCarriage);
        }
        const trimmed = noCarriage.trim();
        if (trimmed && !variants.includes(trimmed)) {
            variants.push(trimmed);
        }
        return variants;
    }

    private findClosestMatch(
        text: string,
        snippet: string,
        lineHint: number,
    ): { index: number; line: number } | undefined {
        const offsets: { index: number; line: number }[] = [];
        const lineStarts: number[] = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10 /* \n */) {
                lineStarts.push(i + 1);
            }
        }
        const lineFromOffset = (offset: number) => {
            let lo = 0;
            let hi = lineStarts.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                const start = lineStarts[mid];
                const next =
                    mid + 1 < lineStarts.length
                        ? lineStarts[mid + 1]
                        : Number.POSITIVE_INFINITY;
                if (offset < start) {
                    hi = mid - 1;
                } else if (offset >= next) {
                    lo = mid + 1;
                } else {
                    return mid + 1;
                }
            }
            return 1;
        };

        let searchIndex = 0;
        while (true) {
            const found = text.indexOf(snippet, searchIndex);
            if (found === -1) break;
            offsets.push({ index: found, line: lineFromOffset(found) });
            searchIndex = found + 1;
        }

        if (offsets.length === 0) return undefined;

        let best = offsets[0];
        let bestDist = Math.abs(offsets[0].line - lineHint);
        for (let i = 1; i < offsets.length; i++) {
            const dist = Math.abs(offsets[i].line - lineHint);
            if (dist < bestDist) {
                best = offsets[i];
                bestDist = dist;
            }
        }
        return best;
    }

    private fuzzyFindSnippet(
        doc: vscode.TextDocument,
        text: string,
        snippet: string,
        lineHint: number,
    ): SnippetMatch | undefined {
        const normalizedQuery = this.normalizeForFuzzy(snippet);
        if (!normalizedQuery) return undefined;

        const rawLines = text.split(/\r?\n/);
        if (rawLines.length === 0) return undefined;

        const queryLines = normalizedQuery.split("\n");
        const baseSize = Math.max(1, queryLines.length);
        const candidateSizes = new Set<number>([baseSize]);
        if (baseSize > 1) candidateSizes.add(baseSize - 1);
        candidateSizes.add(Math.min(baseSize + 1, rawLines.length));

        let best:
            | { score: number; startLine: number; endLine: number }
            | undefined;

        for (const size of candidateSizes) {
            if (size <= 0 || size > rawLines.length) continue;
            for (
                let startIdx = 0;
                startIdx <= rawLines.length - size;
                startIdx++
            ) {
                const windowLines = rawLines.slice(startIdx, startIdx + size);
                const windowNormalized = this.normalizeForFuzzy(
                    windowLines.join("\n"),
                );
                if (!windowNormalized) continue;
                const result = fuzzysort.single(
                    normalizedQuery,
                    windowNormalized,
                );
                if (!result) continue;

                const centerLine = startIdx + Math.ceil(size / 2);
                const distance = Math.abs(centerLine - lineHint);
                const penalty = distance * 5;
                const adjustedScore = result.score - penalty;
                if (!best || adjustedScore > best.score) {
                    best = {
                        score: adjustedScore,
                        startLine: startIdx + 1,
                        endLine: startIdx + size,
                    };
                }
            }
        }

        if (!best) return undefined;

        const startPos = doc.lineAt(best.startLine - 1).range.start;
        const endLine = Math.max(best.endLine, best.startLine);
        const endPos = doc.lineAt(endLine - 1).range.end;
        return {
            range: new vscode.Range(startPos, endPos),
            startLine: best.startLine,
            endLine,
            matchType: "fuzzy",
        };
    }

    private normalizeForFuzzy(value: string): string {
        return value
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((line) => line.trim())
            .join("\n")
            .trim();
    }

    private async highlightRange(
        doc: vscode.TextDocument,
        range: vscode.Range,
    ): Promise<boolean> {
        try {
            const editor = await vscode.window.showTextDocument(doc, {
                selection: new vscode.Selection(range.start, range.start),
            });
            editor.revealRange(
                range,
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
            const decoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: "#1e90ff55",
            });
            editor.setDecorations(decoration, [range]);
            await this.sleep(500);
            editor.setDecorations(decoration, []);
            decoration.dispose();
            return true;
        } catch (error) {
            this.log(`Failed to reveal snippet: ${String(error)}`);
            return false;
        }
    }

    private async sleep(ms: number) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private toRelativeDisplay(fsPath: string) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return fsPath;
        }
        const candidates: string[] = [];
        for (const folder of folders) {
            const relative = path.relative(folder.uri.fsPath, fsPath);
            if (
                relative &&
                !relative.startsWith("..") &&
                !path.isAbsolute(relative)
            ) {
                candidates.push(relative);
            } else if (!relative) {
                candidates.push(path.basename(fsPath));
            }
        }
        if (candidates.length === 0) {
            return fsPath;
        }
        return candidates.reduce((shortest, current) =>
            current.length < shortest.length ? current : shortest,
        );
    }

    private pathsEqual(a: string, b: string) {
        const normA = path.normalize(a);
        const normB = path.normalize(b);
        if (process.platform === "win32") {
            return normA.toLowerCase() === normB.toLowerCase();
        }
        return normA === normB;
    }
}

type WorkspaceFileTarget = {
    fullPath: string;
    relativePath: string;
};

type SnippetMatch = {
    range: vscode.Range;
    startLine: number;
    endLine: number;
    matchType: "exact" | "fuzzy";
};
