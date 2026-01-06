import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "mcp-zod";
import * as vscode from "vscode";
import {
    getEffectiveActiveTextDocument,
    setLastRealFileUri,
} from "./current_file_tracker";
import { BaseMcpHttpServer } from "./mcp_base";
import { INSTANT_CODE_SERVER_NAME } from "@voice-coding/shared-types";

export class InstantCodeServer extends BaseMcpHttpServer {
    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(INSTANT_CODE_SERVER_NAME, log, context);
    }

    // private clipboardText: string | undefined;

    protected createMcpServer(): McpServer {
        const server = new McpServer(
            { name: INSTANT_CODE_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );

        server.registerTool(
            "edit",
            {
                description: "Replace text in the active file with new text.",
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
                    `Tool applyChange called with args ${JSON.stringify({
                        approximateLineNumber: approximateLineNumber,
                        currentTextLength: currentText.length,
                        currentText: this.previewForLog(currentText),
                        newTextLength: newText.length,
                        newText: this.previewForLog(newText),
                    })}`
                );
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for change.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                this.log(
                    `applyChange resolved active document ${doc.uri.fsPath} with ${doc.lineCount} lines`
                );

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
                this.log(
                    `applyChange will replace text near line ${match.line} at offset ${match.index}`
                );

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

                const savePromise = doc.save().then(
                    (ok) => {
                        if (ok) {
                            setLastRealFileUri(doc.uri);
                        } else {
                            this.log(
                                "Document save returned false after instant change."
                            );
                        }
                    },
                    (error) => {
                        this.log(
                            `Failed to save document after instant change: ${String(
                                error
                            )}`
                        );
                    }
                );

                await savePromise;

                const highlightEnd = doc.positionAt(
                    match.index + newText.length
                );
                const flashPromise = this.fadeHighlight(doc, [
                    new vscode.Range(start, highlightEnd),
                ]);
                await flashPromise;
                // await Promise.all([flashPromise, savePromise]);
                const msg = `Applied inline change at line ${match.line}.`;
                this.log(msg);
                return {
                    content: [{ type: "text", text: msg }],
                    filePath: doc.uri.fsPath,
                };
            }
        );

        server.registerTool(
            "insert",
            {
                description:
                    "Insert text at a specific line in the active file. Text currently at that line and below will be shifted down.",
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
                this.log(
                    `Tool applyInsert called with args ${JSON.stringify({
                        line: lineNumber,
                        newTextLength: newText.length,
                        newTextPreview: this.previewForLog(newText),
                    })}`
                );
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for insert.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                this.log(
                    `applyInsert resolved active document ${doc.uri.fsPath} with ${doc.lineCount} lines`
                );

                const { insertOffset, insertPosition, clampedLine } =
                    this.resolveInsertPosition(doc, lineNumber);
                this.log(
                    `applyInsert will insert at line ${clampedLine}, offset ${insertOffset}`
                );
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

                const savePromise = doc.save().then(
                    (ok) => {
                        if (ok) {
                            setLastRealFileUri(doc.uri);
                        } else {
                            this.log(
                                "Document save returned false after instant insert."
                            );
                        }
                    },
                    (error) => {
                        this.log(
                            `Failed to save document after instant insert: ${String(
                                error
                            )}`
                        );
                    }
                );

                await savePromise;

                const end = doc.positionAt(insertOffset + textToInsert.length);
                const flashPromise = this.fadeHighlight(doc, [
                    new vscode.Range(insertPosition, end),
                ]);

                await flashPromise;

                // await Promise.all([flashPromise, savePromise]);
                const msg = `Inserted text at line ${clampedLine}.`;
                this.log(msg);
                return {
                    content: [{ type: "text", text: msg }],
                    filePath: doc.uri.fsPath,
                };
            }
        );

        server.registerTool(
            "delete",
            {
                description: "Remove text from the active file.",
                inputSchema: z.object({
                    text: z
                        .string()
                        .min(1)
                        .describe(
                            "Exact text to delete (at least 1 line). Do not include line numbers."
                        ),
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
                text,
                approximateLineNumber,
            }: {
                text: string;
                approximateLineNumber: number;
            }) => {
                this.log(
                    `Tool applyDelete called with args ${JSON.stringify({
                        line: approximateLineNumber,
                        textLength: text.length,
                        textPreview: this.previewForLog(text),
                    })}`
                );
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open for delete.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                this.log(
                    `applyDelete resolved active document ${doc.uri.fsPath} with ${doc.lineCount} lines`
                );

                const match = this.findClosestMatch(
                    doc.getText(),
                    text,
                    approximateLineNumber
                );
                if (!match) {
                    const msg = "Text not found in current file.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                this.log(
                    `applyDelete will remove text near line ${match.line} starting at offset ${match.index}`
                );

                const start = doc.positionAt(match.index);
                const end = doc.positionAt(match.index + match.matchLength);

                const flashPromise = this.flashHighlight(doc, [
                    new vscode.Range(start, end),
                ]);

                await flashPromise;

                const edit = new vscode.WorkspaceEdit();
                edit.delete(doc.uri, new vscode.Range(start, end));
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    const msg = "Failed to delete text.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const savePromise = doc.save().then(
                    (ok) => {
                        if (ok) {
                            setLastRealFileUri(doc.uri);
                        } else {
                            this.log(
                                "Document save returned false after instant delete."
                            );
                        }
                    },
                    (error) => {
                        this.log(
                            `Failed to save document after instant delete: ${String(
                                error
                            )}`
                        );
                    }
                );
                await savePromise;
                // await Promise.all([flashPromise, savePromise]);
                const msg = `Deleted text near line ${match.line}.`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        // server.registerTool(
        //     "copyText",
        //     {
        //         description:
        //             "Store text in a server-side clipboard for later pasting within the IDE.",
        //         inputSchema: z.object({
        //             text: z
        //                 .string()
        //                 .min(1)
        //                 .describe("Text to copy into clipboard"),
        //         }).shape,
        //     },
        //     async ({ text }: { text: string }) => {
        //         this.clipboardText = text;
        //         const doc = await getEffectiveActiveTextDocument();
        //         if (doc && doc.uri.scheme === "file") {
        //             const match = this.findClosestMatch(doc.getText(), text, 1);
        //             if (match) {
        //                 const start = doc.positionAt(match.index);
        //                 const end = doc.positionAt(
        //                     match.index + match.matchLength
        //                 );
        //                 await this.flashHighlight(doc, [
        //                     new vscode.Range(start, end),
        //                 ]);
        //             }
        //         }
        //         const msg = `Copied ${text.length} characters to clipboard.`;
        //         this.log(msg);
        //         return { content: [{ type: "text", text: msg }] };
        //     }
        // );

        // server.registerTool(
        //     "pasteText",
        //     {
        //         description:
        //             "Paste the last copied text above a specific line in the active file.",
        //         inputSchema: z.object({
        //             lineNumber: z
        //                 .number()
        //                 .int()
        //                 .min(1)
        //                 .describe(
        //                     "1-based line number; clipboard content will be inserted above this line"
        //                 ),
        //         }).shape,
        //     },
        //     async ({ lineNumber }: { lineNumber: number }) => {
        //         if (!this.clipboardText) {
        //             const msg = "Clipboard is empty. Call copy first.";
        //             this.log(msg);
        //             return { content: [{ type: "text", text: msg }] };
        //         }

        //         const doc = await getEffectiveActiveTextDocument();
        //         if (!doc || doc.uri.scheme !== "file") {
        //             const msg = "No active file is open for paste.";
        //             this.log(msg);
        //             return { content: [{ type: "text", text: msg }] };
        //         }
        //         this.log(
        //             `paste resolved active document ${doc.uri.fsPath} with ${doc.lineCount} lines`
        //         );

        //         const { insertOffset, insertPosition, clampedLine } =
        //             this.resolveInsertPosition(doc, lineNumber);
        //         const edit = new vscode.WorkspaceEdit();
        //         edit.insert(doc.uri, insertPosition, this.clipboardText);
        //         const applied = await vscode.workspace.applyEdit(edit);
        //         if (!applied) {
        //             const msg = "Failed to paste text.";
        //             this.log(msg);
        //             return { content: [{ type: "text", text: msg }] };
        //         }

        //         const savePromise = doc.save().then(
        //             (ok) => {
        //                 if (ok) {
        //                     setLastRealFileUri(doc.uri);
        //                 } else {
        //                     this.log(
        //                         "Document save returned false after paste."
        //                     );
        //                 }
        //             },
        //             (error) => {
        //                 this.log(
        //                     `Failed to save document after paste: ${String(
        //                         error
        //                     )}`
        //                 );
        //             }
        //         );

        //         const end = doc.positionAt(
        //             insertOffset + this.clipboardText.length
        //         );
        //         const flashPromise = this.fadeHighlight(doc, [
        //             new vscode.Range(insertPosition, end),
        //         ]);

        //         await Promise.all([flashPromise, savePromise]);
        //         const msg = `Pasted clipboard above line ${clampedLine}.`;
        //         this.log(msg);
        //         return { content: [{ type: "text", text: msg }] };
        //     }
        // );

        server.registerTool(
            "createFile",
            {
                description:
                    "Create a file with the provided contents and highlight the new document.",
                inputSchema: z.object({
                    filePath: z
                        .string()
                        .describe(
                            "file:// URI or absolute path for the file. It must not already exist."
                        ),
                    newText: z.string().describe("Contents to write"),
                }).shape,
            },
            async ({
                filePath,
                newText,
            }: {
                filePath: string;
                newText: string;
            }) => {
                this.log(
                    `Tool applyCreate called with args ${JSON.stringify({
                        filePath,
                        newTextLength: newText.length,
                        newTextPreview: this.previewForLog(newText),
                    })}`
                );
                const target = this.parseTargetUri(filePath);
                this.log(
                    `applyCreate resolved target URI ${target.toString()}`
                );
                try {
                    await vscode.workspace.fs.stat(target);
                    const msg = `Refusing to overwrite existing file ${target.fsPath}.`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                } catch {
                    // file does not exist; continue
                }

                const edit = new vscode.WorkspaceEdit();
                edit.createFile(target, { overwrite: false });
                edit.insert(target, new vscode.Position(0, 0), newText);
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    const msg = `Failed to create ${target.fsPath}.`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                const doc = await vscode.workspace.openTextDocument(target);
                const savePromise = doc.save().then(
                    (ok) => {
                        if (ok) {
                            setLastRealFileUri(target);
                        } else {
                            this.log(
                                "Document save returned false after instant create."
                            );
                        }
                    },
                    (error) => {
                        this.log(
                            `Failed to save document after instant create: ${String(
                                error
                            )}`
                        );
                    }
                );

                const flashPromise = this.fadeHighlight(doc, [
                    this.fullDocumentRange(doc),
                ]);
                await Promise.all([flashPromise, savePromise]);
                const msg = `Created ${target.fsPath}.`;
                this.log(msg);
                return { content: [{ type: "text", text: msg }] };
            }
        );

        return server;
    }

    private parseTargetUri(filePath: string): vscode.Uri {
        try {
            return filePath.startsWith("file://")
                ? vscode.Uri.parse(filePath)
                : vscode.Uri.file(filePath);
        } catch {
            return vscode.Uri.file(filePath);
        }
    }

    private previewForLog(text: string, limit = 120): string {
        if (text.length <= limit) {
            return text;
        }
        return `${text.slice(0, limit)}...`;
    }

    // Generates candidate snippets while varying leading tab indentation by up to three tabs.
    private generateTabAdjustedVariants(snippet: string): string[] {
        const variants: string[] = [];
        const seen = new Set<string>();
        const pushVariant = (candidate: string) => {
            if (!seen.has(candidate)) {
                variants.push(candidate);
                seen.add(candidate);
            }
        };

        pushVariant(snippet);

        const hasTrailingNewline = snippet.endsWith("\n");
        const baseLines = snippet.split("\n");
        if (hasTrailingNewline) {
            baseLines.pop();
        }

        if (baseLines.length === 0) {
            return variants;
        }

        const allLinesStartWithTab = baseLines.every((line) =>
            line.startsWith("\t")
        );
        if (!allLinesStartWithTab) {
            return variants;
        }

        const leadingTabCounts = baseLines.map((line) => {
            let count = 0;
            while (
                count < line.length &&
                line.charCodeAt(count) === 9 /* \t */
            ) {
                count++;
            }
            return count;
        });
        const minTabs = Math.min(...leadingTabCounts);

        const adjustments = [1, -1, 2, -2, 3, -3];
        for (const adjustment of adjustments) {
            if (adjustment > 0) {
                const adjustedLines = baseLines.map(
                    (line) => "\t".repeat(adjustment) + line
                );
                let variant = adjustedLines.join("\n");
                if (hasTrailingNewline) {
                    variant += "\n";
                }
                pushVariant(variant);
                continue;
            }

            const removeCount = Math.abs(adjustment);
            if (removeCount > minTabs) {
                continue;
            }
            const adjustedLines = baseLines.map((line) =>
                line.slice(removeCount)
            );
            let variant = adjustedLines.join("\n");
            if (hasTrailingNewline) {
                variant += "\n";
            }
            pushVariant(variant);
        }

        return variants;
    }

    private findClosestMatch(
        text: string,
        snippet: string,
        lineHint: number
    ): { index: number; line: number; matchLength: number } | undefined {
        for (const variant of this.generateTabAdjustedVariants(snippet)) {
            const exact = this.findClosestMatchExact(text, variant, lineHint);
            if (exact) {
                return { ...exact, matchLength: variant.length };
            }
        }
        return undefined;
    }

    private findClosestMatchExact(
        text: string,
        snippet: string,
        lineHint: number
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

    private fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
        if (doc.lineCount === 0) {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 0)
            );
        }
        const first = new vscode.Position(0, 0);
        const lastLine = doc.lineCount - 1;
        const last = doc.lineAt(lastLine).range.end;
        return new vscode.Range(first, last);
    }

    private async fadeHighlight(
        doc: vscode.TextDocument,
        ranges: vscode.Range[]
    ) {
        if (ranges.length === 0) return;
        const editor = await this.showDocument(doc, ranges[0].start);
        if (!editor) return;

        const opaqueColor = "#6cc75a";

        const STEPS = 10;
        const STEP_DELAY_MS = 50;
        let previousDecoration: vscode.TextEditorDecorationType | undefined;
        for (let i = 0; i < STEPS; i++) {
            const currentAlpha = Math.round((1 - i / STEPS) * 100);
            const currentAlphaHex = currentAlpha.toString(16).padStart(2, "0");
            const step = opaqueColor + currentAlphaHex;

            const decoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: step,
            });
            editor.setDecorations(decoration, ranges);
            if (previousDecoration) {
                editor.setDecorations(previousDecoration, []);
                previousDecoration.dispose();
            }
            previousDecoration = decoration;
            await this.sleep(STEP_DELAY_MS);
        }
        if (previousDecoration) {
            editor.setDecorations(previousDecoration, []);
            previousDecoration.dispose();
        }
    }

    // flashes highlight in and out
    private async flashHighlight(
        doc: vscode.TextDocument,
        ranges: vscode.Range[]
    ) {
        if (ranges.length === 0) return;
        const editor = await this.showDocument(doc, ranges[0].start);
        if (!editor) return;

        const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: "#dc322f80",
        });
        editor.setDecorations(decoration, ranges);
        await this.sleep(300);
        editor.setDecorations(decoration, []);
        decoration.dispose();
    }

    private async showDocument(
        doc: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.TextEditor | undefined> {
        try {
            const editor = await vscode.window.showTextDocument(doc, {
                selection: new vscode.Selection(position, position),
            });
            return editor;
        } catch (error) {
            this.log(`Failed to reveal document: ${String(error)}`);
            return undefined;
        }
    }

    private async sleep(ms: number) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
}
