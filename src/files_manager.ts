import * as vscode from "vscode";
import {
    CONTEXT_DEBOUNCE_MS,
    MAX_SELECTION_LEN,
    MAX_WORKSPACE_FILES,
    MAX_VISIBLE_CHARS,
    MAX_VISIBLE_LINES,
    WORKSPACE_FILE_EXCLUDES,
} from "./consts";
import { getLastRealFileUri } from "./current_file_tracker";
import {
    IdeContextPayload,
    OpenFileInfo,
    SelectedText,
} from "@voice-coding/shared-types";

export class FilesManager {
    private readonly openFiles: OpenFileInfo[] = [];
    private debounceTimer?: NodeJS.Timeout;
    private onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onChangeEmitter.event;

    constructor(private readonly subscriptions: vscode.Disposable[]) {
        const subs = [
            vscode.window.onDidChangeActiveTextEditor(() =>
                this.captureAndFire()
            ),
            vscode.window.onDidChangeTextEditorSelection(() =>
                this.captureAndFire()
            ),
            vscode.workspace.onDidCloseTextDocument(() =>
                this.captureAndFire()
            ),
            vscode.workspace.onDidRenameFiles(() => this.captureAndFire()),
            vscode.workspace.onDidDeleteFiles(() => this.captureAndFire()),
            vscode.workspace.onDidCreateFiles?.(() => this.captureAndFire()),
        ];
        this.subscriptions.push(...subs);
        this.captureAndFire(); // seed
    }

    private captureAndFire() {
        this.capture();
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(
            () => this.onChangeEmitter.fire(),
            CONTEXT_DEBOUNCE_MS
        );
    }

    private capture() {
        const visible = vscode.window.visibleTextEditors.filter(
            (e) => e.document.uri.scheme === "file"
        );
        const activeEditor = vscode.window.activeTextEditor;
        const liveActiveUri =
            activeEditor?.document.uri.scheme === "file"
                ? activeEditor.document.uri.fsPath
                : undefined;
        const lastReal = getLastRealFileUri()?.fsPath;
        const activeUri = liveActiveUri ?? lastReal;
        const now = Date.now();

        const list: OpenFileInfo[] = [];
        for (const ed of visible) {
            const fsPath = ed.document.uri.fsPath;
            const isActive = fsPath === activeUri;

            let selectedText = ed.document.getText(ed.selection);
            if (selectedText && selectedText.length > MAX_SELECTION_LEN) {
                selectedText =
                    selectedText.slice(0, MAX_SELECTION_LEN) +
                    "... [TRUNCATED]";
            }
            let selection: SelectedText | undefined;
            if (selectedText) {
                selection = {
                    text: selectedText,
                    startLine: ed.selection.start.line + 1,
                    endLine: ed.selection.end.line + 1,
                };
            }

            let visibleText: OpenFileInfo["visibleText"];
            let visibleLineRange: OpenFileInfo["visibleLineRange"];
            const doc = ed.document;
            const visibleRange = ed.visibleRanges[0];
            if (visibleRange) {
                const startLine = visibleRange.start.line;
                let endLine = visibleRange.end.line;
                if (visibleRange.end.character === 0 && endLine > startLine) {
                    endLine -= 1;
                }
                visibleLineRange = {
                    startLine: startLine + 1,
                    endLine: endLine + 1,
                };
                const maxEndLine = Math.min(
                    doc.lineCount - 1,
                    startLine + MAX_VISIBLE_LINES - 1,
                    endLine
                );
                const lines: string[] = [];
                let charBudget = MAX_VISIBLE_CHARS;
                for (
                    let line = startLine;
                    line <= maxEndLine && charBudget > 0;
                    line++
                ) {
                    const fullLine = doc.lineAt(line).text ?? "";
                    if (fullLine.length > charBudget) {
                        lines.push(
                            fullLine.slice(0, Math.max(charBudget, 0)) +
                                "... [TRUNCATED]"
                        );
                        charBudget = 0;
                    } else {
                        lines.push(fullLine);
                        charBudget -= fullLine.length;
                    }
                }
                if (lines.length > 0) {
                    visibleText = {
                        startLine: startLine + 1,
                        lines,
                    };
                }
            }

            list.push({
                path: fsPath,
                isActive,
                timestamp: now,
                fullText: doc.getText(),
                cursor: ed.selection?.active
                    ? {
                          line: ed.selection.active.line + 1,
                          character: ed.selection.active.character,
                      }
                    : undefined,
                selection: selection,
                visibleLineRange,
                visibleText,
            });
        }

        const active = vscode.window.activeTextEditor;
        if (
            active &&
            active.document.uri.scheme === "file" &&
            !list.find((f) => f.path === active.document.uri.fsPath)
        ) {
            let selectedText = active.document.getText(active.selection);
            if (selectedText && selectedText.length > MAX_SELECTION_LEN) {
                selectedText =
                    selectedText.slice(0, MAX_SELECTION_LEN) +
                    "... [TRUNCATED]";
            }

            let selection: SelectedText | undefined;
            if (selectedText) {
                selection = {
                    text: selectedText,
                    startLine: active.selection.start.line + 1,
                    endLine: active.selection.end.line + 1,
                };
            }

            let visibleText: OpenFileInfo["visibleText"];
            let visibleLineRange: OpenFileInfo["visibleLineRange"];
            const doc = active.document;
            const visibleRange = active.visibleRanges[0];
            if (visibleRange) {
                const startLine = visibleRange.start.line;
                let endLine = visibleRange.end.line;
                if (visibleRange.end.character === 0 && endLine > startLine) {
                    endLine -= 1;
                }
                visibleLineRange = {
                    startLine: startLine + 1,
                    endLine: endLine + 1,
                };
                const maxEndLine = Math.min(
                    doc.lineCount - 1,
                    startLine + MAX_VISIBLE_LINES - 1,
                    endLine
                );
                const lines: string[] = [];
                let charBudget = MAX_VISIBLE_CHARS;
                for (
                    let line = startLine;
                    line <= maxEndLine && charBudget > 0;
                    line++
                ) {
                    const fullLine = doc.lineAt(line).text ?? "";
                    if (fullLine.length > charBudget) {
                        lines.push(
                            fullLine.slice(0, Math.max(charBudget, 0)) +
                                "... [TRUNCATED]"
                        );
                        charBudget = 0;
                    } else {
                        lines.push(fullLine);
                        charBudget -= fullLine.length;
                    }
                }
                if (lines.length > 0) {
                    visibleText = {
                        startLine: startLine + 1,
                        lines,
                    };
                }
            }

            list.unshift({
                path: active.document.uri.fsPath,
                isActive: true,
                timestamp: now,
                fullText: doc.getText(),
                cursor: active.selection?.active
                    ? {
                          line: active.selection.active.line + 1,
                          character: active.selection.active.character,
                      }
                    : undefined,
                selection: selection,
                visibleLineRange,
                visibleText,
            });
        }

        // If no file editor is active (e.g., diff right-side), ensure the last real file
        // is marked active in the list if present.
        if (!liveActiveUri && lastReal) {
            const idx = list.findIndex((f) => f.path === lastReal);
            if (idx >= 0) {
                list.forEach((f, i) => (f.isActive = i === idx));
            }
        }

        this.openFiles.length = 0;
        this.openFiles.push(...list);
    }

    async getWorkspaceFiles(): Promise<string[]> {
        try {
            const uris = await vscode.workspace.findFiles(
                "**/*",
                WORKSPACE_FILE_EXCLUDES,
                MAX_WORKSPACE_FILES
            );
            return uris.map((u) => u.fsPath);
        } catch {
            return [];
        }
    }

    async state(): Promise<IdeContextPayload> {
        return {
            workspaceState: {
                isTrusted: vscode.workspace.isTrusted,
                openFiles: [...this.openFiles],
                workspaceFiles: await this.getWorkspaceFiles(),
            },
        };
    }
}
