import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "mcp-zod";
import * as path from "node:path";
import * as vscode from "vscode";
import { BaseMcpHttpServer } from "./mcp_base";
import {
    getEffectiveActiveTextDocument,
    setLastRealFileUri,
} from "./current_file_tracker";
import { DiffManager } from "./diff_manager";
import type { DiffKind } from "./diff_manager";
import { InlinePreviewManager } from "./inline_preview_manager";
import { CODE_SERVER_NAME } from "@voice-coding/shared-types";

export class CodeServer extends BaseMcpHttpServer {
    constructor(
        log: (msg: string) => void,
        context: vscode.ExtensionContext,
        private readonly diffManager: DiffManager,
        private readonly inlinePreviewManager: InlinePreviewManager
    ) {
        super(CODE_SERVER_NAME, log, context);
    }

    protected createMcpServer() {
        const server = new McpServer(
            { name: CODE_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );

        const parseTargetUri = (filePath: string): vscode.Uri => {
            try {
                return filePath.startsWith("file://")
                    ? vscode.Uri.parse(filePath)
                    : vscode.Uri.file(filePath);
            } catch {
                return vscode.Uri.file(filePath);
            }
        };

        server.registerTool(
            "showDiff",
            {
                description:
                    "(Final Tool) Show a red/green unified diff by replacing currentText with newText at the closest match to approximateLineNumber in the current file. You must read the file before using this tool.",
                inputSchema: z.object({
                    currentText: z
                        .string()
                        .min(1)
                        .describe(
                            "Exact text to replace (at least 1 line). Do not include line numbers."
                        ),
                    newText: z.string().describe("Replacement text"),
                    approximateLineNumber: z
                        .number()
                        .int()
                        .min(1)
                        .describe(
                            "1-based line number to disambiguate when multiple matches exist"
                        ),
                }).shape,
            },
            async ({
                currentText,
                newText,
                approximateLineNumber,
            }: {
                currentText: string;
                newText: string;
                approximateLineNumber: number;
            }) => {
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for diff.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                const original = doc.getText();

                // Find all occurrences of currentText
                const offsets: { index: number; line: number }[] = [];
                const lineStarts: number[] = [0];
                for (let i = 0; i < original.length; i++) {
                    if (original.charCodeAt(i) === 10 /* \n */) {
                        lineStarts.push(i + 1);
                    }
                }
                function lineFromOffset(off: number): number {
                    // binary search in lineStarts; returns 1-based line
                    let lo = 0,
                        hi = lineStarts.length - 1;
                    while (lo <= hi) {
                        const mid = (lo + hi) >>> 1;
                        const start = lineStarts[mid];
                        const next =
                            mid + 1 < lineStarts.length
                                ? lineStarts[mid + 1]
                                : Infinity;
                        if (off < start) hi = mid - 1;
                        else if (off >= next) lo = mid + 1;
                        else return mid + 1; // 1-based
                    }
                    return 1;
                }

                let pos = 0;
                while (true) {
                    const idx = original.indexOf(currentText, pos);
                    if (idx === -1) break;
                    offsets.push({ index: idx, line: lineFromOffset(idx) });
                    pos = idx + 1;
                }

                if (offsets.length === 0) {
                    const msg = `Text not found in current file.`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                // Choose the occurrence closest to approximateLineNumber
                let chosen = offsets[0];
                let bestDist = Math.abs(
                    offsets[0].line - approximateLineNumber
                );
                for (let i = 1; i < offsets.length; i++) {
                    const d = Math.abs(offsets[i].line - approximateLineNumber);
                    if (d < bestDist) {
                        bestDist = d;
                        chosen = offsets[i];
                    }
                }

                const newContent =
                    original.slice(0, chosen.index) +
                    newText +
                    original.slice(chosen.index + currentText.length);

                // Write to a temp/proposed file near extension storage to preserve language mode by extension
                const origFsPath = doc.uri.fsPath;
                const base = path.basename(origFsPath);
                const proposedUri = await this.writeScratchFile(
                    base,
                    "proposed",
                    newContent
                );

                const title = `Proposed edit for ${base} @ line ${chosen.line}`;

                await this.resetPendingChange();
                const start = doc.positionAt(chosen.index);
                const end = doc.positionAt(chosen.index + currentText.length);
                await this.inlinePreviewManager.showReplacement(
                    doc,
                    new vscode.Range(start, end),
                    newText
                );
                this.recordPendingChange({
                    kind: "modify",
                    target: doc.uri,
                    original: doc.uri,
                    modified: proposedUri,
                    title,
                    focusLine: chosen.line,
                });

                const msg = `Prepared inline preview. Replacing occurrence closest to line ${approximateLineNumber} (matched at line ${chosen.line}).`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        server.registerTool(
            "showInsert",
            {
                description:
                    "(Final Tool) Show a red/green unified diff by inserting newText at lineNumber in the current file. You must read the file before using this tool.",
                inputSchema: z.object({
                    newText: z.string().describe("Text to insert"),
                    lineNumber: z
                        .number()
                        .int()
                        .min(1)
                        .describe(
                            "1-based line number where the text will be inserted"
                        ),
                }).shape,
            },
            async ({
                newText,
                lineNumber,
            }: {
                newText: string;
                lineNumber: number;
            }) => {
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for diff.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const original = doc.getText();
                const clampedLine = Math.max(
                    1,
                    Math.min(lineNumber, doc.lineCount + 1)
                );
                const zeroBasedLine = clampedLine - 1;
                let insertOffset = original.length;
                if (zeroBasedLine < doc.lineCount) {
                    const insertPosition =
                        doc.lineAt(zeroBasedLine).range.start;
                    insertOffset = doc.offsetAt(insertPosition);
                }

                const newContent =
                    original.slice(0, insertOffset) +
                    newText +
                    original.slice(insertOffset);

                const base = path.basename(doc.uri.fsPath);
                const proposedUri = await this.writeScratchFile(
                    base,
                    "insert",
                    newContent
                );
                const title = `Proposed insert for ${base} @ line ${clampedLine}`;

                await this.resetPendingChange();
                const insertPosition = doc.positionAt(insertOffset);
                await this.inlinePreviewManager.showInsertion(
                    doc,
                    insertPosition,
                    newText
                );
                this.recordPendingChange({
                    kind: "modify",
                    target: doc.uri,
                    original: doc.uri,
                    modified: proposedUri,
                    title,
                    focusLine: clampedLine,
                });

                const msg = `Prepared inline preview. Inserted text at line ${clampedLine}.`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        // Show a diff representing creating a new file at filePath with newText
        server.registerTool(
            "showCreate",
            {
                description:
                    "Show a diff to create a new file. The original side is empty, the modified side is the provided content.",
                inputSchema: z.object({
                    filePath: z
                        .string()
                        .describe(
                            "file:// URI or absolute path of the new file"
                        ),
                    newText: z.string().describe("Contents for the new file"),
                }).shape,
            },
            async ({
                filePath,
                newText,
            }: {
                filePath: string;
                newText: string;
            }) => {
                const target = parseTargetUri(filePath);
                const baseName = path.basename(target.fsPath);
                const proposedUri = await this.writeScratchFile(
                    baseName,
                    "create",
                    newText
                );

                // Empty original with same extension to preserve language mode
                const emptyUri = await this.writeScratchFile(
                    baseName,
                    "empty",
                    ""
                );

                const title = `Proposed create ${target.fsPath}`;

                await this.resetPendingChange();
                const proposedDoc = await vscode.workspace.openTextDocument(
                    proposedUri
                );
                await vscode.window.showTextDocument(proposedDoc, {
                    preview: true,
                });
                this.recordPendingChange({
                    kind: "create",
                    target,
                    original: emptyUri,
                    modified: proposedUri,
                    title,
                    focusLine: 1,
                });

                const msg = `Prepared preview to create ${target.fsPath}.`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        // Show a diff representing deleting a file at filePath
        server.registerTool(
            "showDelete",
            {
                description:
                    "Show a diff to delete a file. The original side is the current file, the modified side is empty.",
                inputSchema: z.object({
                    filePath: z
                        .string()
                        .describe(
                            "file:// URI or absolute path of the file to delete"
                        ),
                }).shape,
            },
            async ({ filePath }: { filePath: string }) => {
                const target = parseTargetUri(filePath);

                const baseName = path.basename(target.fsPath);
                const emptyUri = await this.writeScratchFile(
                    baseName,
                    "delete",
                    ""
                );
                const title = `Proposed delete ${target.fsPath}`;

                await this.resetPendingChange();
                let deleteDoc: vscode.TextDocument | undefined;
                try {
                    deleteDoc = await vscode.workspace.openTextDocument(target);
                } catch (error) {
                    this.log(
                        `Unable to open ${
                            target.fsPath
                        } for inline delete preview: ${String(error)}.`
                    );
                }
                if (deleteDoc) {
                    const fullRange = new vscode.Range(
                        deleteDoc.positionAt(0),
                        deleteDoc.positionAt(deleteDoc.getText().length)
                    );
                    await this.inlinePreviewManager.showDeletion(
                        deleteDoc,
                        fullRange
                    );
                }
                this.recordPendingChange({
                    kind: "delete",
                    target,
                    original: target,
                    modified: emptyUri,
                    title,
                    focusLine: 1,
                });

                const msg = deleteDoc
                    ? `Prepared inline preview to delete ${target.fsPath}.`
                    : `Queued delete of ${target.fsPath}. Unable to show inline preview.`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        return server;
    }

    private async resetPendingChange() {
        await this.diffManager.closeAllDiffTabs();
        this.inlinePreviewManager.clear();
    }

    private recordPendingChange(params: {
        kind: DiffKind;
        target: vscode.Uri;
        original: vscode.Uri;
        modified: vscode.Uri;
        title: string;
        focusLine?: number;
    }) {
        const { kind, target, original, modified, title, focusLine } = params;
        setLastRealFileUri(target);
        this.diffManager.setCurrent({
            kind,
            target,
            original,
            modified,
            title,
            focusLine,
            displayMode: "inline",
        });
    }

    private async writeScratchFile(
        baseName: string,
        tag: string,
        contents: string
    ): Promise<vscode.Uri> {
        await this.diffManager.ensureScratchDir();
        const diffsDir = this.diffManager.getScratchDir();
        const scratchName = this.buildScratchFileName(baseName, tag);
        const uri = vscode.Uri.joinPath(diffsDir, scratchName);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, "utf8"));
        return uri;
    }

    private buildScratchFileName(baseName: string, tag: string): string {
        const parsed = path.parse(baseName);
        const timestamp = Date.now();
        const ext = parsed.ext ?? "";
        const name = parsed.name || parsed.base || "scratch";
        return `${name}.${tag}-${timestamp}${ext}`;
    }
}
