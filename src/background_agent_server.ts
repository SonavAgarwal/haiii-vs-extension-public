import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "mcp-zod";
import * as vscode from "vscode";
import { BaseMcpHttpServer } from "./mcp_base";
import { getEffectiveActiveTextDocument } from "./current_file_tracker";
import { BACKGROUND_AGENT_SERVER_NAME } from "@voice-coding/shared-types";

export class BackgroundAgentServer extends BaseMcpHttpServer {
    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(BACKGROUND_AGENT_SERVER_NAME, log, context);
    }

    protected createMcpServer(): McpServer {
        const server = new McpServer(
            { name: BACKGROUND_AGENT_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );

        server.registerTool(
            "editText",
            {
                description:
                    "Replace text in the active file without moving the cursor or flashing.",
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
                this.log(
                    `background editText called near line ${approximateLineNumber}`
                );
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for change.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const match = this.findClosestMatch(
                    doc.getText(),
                    currentText,
                    approximateLineNumber
                );
                if (!match) {
                    const msg = "Text not found in current file.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const start = doc.positionAt(match.index);
                const end = doc.positionAt(match.index + match.matchLength);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(start, end), newText);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    const msg = "Failed to apply edit.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                await doc.save();

                const msg = `Applied background edit at line ${match.line}.`;
                this.log(msg);
                return {
                    content: [{ type: "text", text: msg }],
                    filePath: doc.uri.fsPath,
                };
            }
        );

        server.registerTool(
            "insertText",
            {
                description:
                    "Insert text at a specific line in the active file without moving the cursor or flashing.",
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
                this.log(`background insertText called at line ${lineNumber}`);
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for insert.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const { insertPosition, clampedLine } =
                    this.resolveInsertPosition(doc, lineNumber);
                const isExistingLine = clampedLine <= doc.lineCount;
                const needsTrailingNewline =
                    isExistingLine && !newText.endsWith("\n");
                const textToInsert = needsTrailingNewline
                    ? `${newText}\n`
                    : newText;
                const edit = new vscode.WorkspaceEdit();
                edit.insert(doc.uri, insertPosition, textToInsert);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    const msg = "Failed to insert text.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                await doc.save();

                const msg = `Inserted text at line ${clampedLine}.`;
                this.log(msg);
                return {
                    content: [{ type: "text", text: msg }],
                    filePath: doc.uri.fsPath,
                };
            }
        );

        return server;
    }

    private findClosestMatch(
        text: string,
        snippet: string,
        lineHint: number
    ): { index: number; line: number; matchLength: number } | undefined {
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
        return {
            index: best.index,
            line: best.line,
            matchLength: snippet.length,
        };
    }

    private resolveInsertPosition(
        doc: vscode.TextDocument,
        lineNumber: number
    ): {
        insertOffset: number;
        insertPosition: vscode.Position;
        clampedLine: number;
    } {
        const clampedLine = Math.max(
            1,
            Math.min(lineNumber, doc.lineCount + 1)
        );
        const zeroBased = clampedLine - 1;
        if (zeroBased >= doc.lineCount) {
            const offset = doc.getText().length;
            const position = doc.positionAt(offset);
            return {
                insertOffset: offset,
                insertPosition: position,
                clampedLine,
            };
        }
        const position = doc.lineAt(zeroBased).range.start;
        const offset = doc.offsetAt(position);
        return { insertOffset: offset, insertPosition: position, clampedLine };
    }
}
