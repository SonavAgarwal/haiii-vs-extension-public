import * as vscode from "vscode";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { DiffManager, DiffState } from "./diff_manager";
import { registerServer, unregisterServer } from "./connection_helper";
import type {
    IdeContextPayload,
    SelectedText,
} from "@voice-coding/shared-types";

export type ContextUpdateMessage = {
    type: "context-update";
    context: IdeContextPayload;
};

export type SerializedDiffState = {
    kind: "modify" | "create" | "delete";
    title: string;
    targetUri: string;
    targetPath: string;
    originalUri: string;
    modifiedUri: string;
} | null;

export type DiffStateMessage = {
    type: "diff-state";
    diffState: SerializedDiffState;
};

export type ServerMessage = ContextUpdateMessage | DiffStateMessage;

/**
 * WebSocket server that broadcasts IDE context and diff state updates to connected clients.
 * This replaces the MCP notification-based context passing with a simpler WebSocket approach.
 */
export class ContextWebSocketServer {
    private server?: http.Server;
    private wss?: WebSocketServer;
    private port?: number;
    private clients = new Set<WebSocket>();
    private lastContext?: IdeContextPayload;
    private lastDiffState?: SerializedDiffState;

    // Listeners for cleanup
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly log: (msg: string) => void,
        private readonly context: vscode.ExtensionContext,
        private readonly diffManager: DiffManager
    ) {}

    async start(): Promise<void> {
        this.server = http.createServer();
        this.wss = new WebSocketServer({ server: this.server });

        this.wss.on("connection", (ws: WebSocket) => {
            this.log("ContextWebSocketServer: client connected");
            this.clients.add(ws);

            // Send current state immediately on connection
            if (this.lastContext) {
                this.sendToClient(ws, {
                    type: "context-update",
                    context: this.lastContext,
                });
            }
            if (this.lastDiffState !== undefined) {
                this.sendToClient(ws, {
                    type: "diff-state",
                    diffState: this.lastDiffState,
                });
            }

            ws.on("close", () => {
                this.log("ContextWebSocketServer: client disconnected");
                this.clients.delete(ws);
            });

            ws.on("error", (err) => {
                this.log(
                    `ContextWebSocketServer: client error: ${err.message}`
                );
                this.clients.delete(ws);
            });
        });

        // Listen on a random available port (0 means OS assigns)
        await new Promise<void>((resolve, reject) => {
            this.server!.listen(0, () => {
                const address = this.server!.address();
                if (address && typeof address !== "string") {
                    this.port = address.port;
                    this.log(
                        `ContextWebSocketServer listening on port ${this.port}`
                    );
                }
                resolve();
            });
            this.server!.on("error", reject);
        });

        // Register in the server registry so clients can discover this WebSocket server
        if (this.port) {
            await registerServer({
                context: this.context,
                name: "voice-coding-context-ws-server",
                port: this.port,
                workspacePath:
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                    process.cwd(),
            });
        }

        // Set up VSCode listeners for context changes
        this.setupContextListeners();

        // Set up diff manager listener
        this.setupDiffListener();
    }

    async stop(): Promise<void> {
        // Unregister from the server registry
        if (this.port) {
            await unregisterServer({
                context: this.context,
                name: "voice-coding-context-ws-server",
            });
        }

        // Clean up all VSCode listeners
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];

        // Close all WebSocket connections
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();

        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
            this.wss = undefined;
        }

        // Close HTTP server
        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
            this.server = undefined;
        }

        this.log("ContextWebSocketServer stopped");
    }

    getPort(): number | undefined {
        return this.port;
    }

    async ensureRegistered(): Promise<void> {
        if (!this.server) {
            await this.start();
            return;
        }

        if (!this.port) {
            this.log(
                "ContextWebSocketServer: missing port; skipping registry refresh.",
            );
            return;
        }

        await registerServer({
            context: this.context,
            name: "voice-coding-context-ws-server",
            port: this.port,
            workspacePath:
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
                process.cwd(),
        });
    }

    private setupContextListeners(): void {
        // Listen to various VSCode events that should trigger context updates
        const updateContext = () => this.broadcastContext();

        // File open/close/change
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(updateContext),
            vscode.workspace.onDidCloseTextDocument(updateContext),
            vscode.window.onDidChangeActiveTextEditor(updateContext),
            vscode.window.onDidChangeTextEditorSelection(updateContext),
            vscode.window.onDidChangeTextEditorVisibleRanges(updateContext),
            vscode.workspace.onDidChangeTextDocument(updateContext)
        );

        // Initial broadcast
        this.broadcastContext();
    }

    private setupDiffListener(): void {
        const unsubscribe = this.diffManager.onChange((state) => {
            this.broadcastDiffState(state);
        });

        // Store cleanup function
        this.disposables.push({
            dispose: unsubscribe,
        });

        // Initial broadcast of current diff state
        this.broadcastDiffState(this.diffManager.getCurrent());
    }

    private broadcastContext(): void {
        const context = this.gatherContext();
        this.lastContext = context;

        const message: ContextUpdateMessage = {
            type: "context-update",
            context,
        };

        this.broadcast(message);
    }

    private broadcastDiffState(state: DiffState | undefined): void {
        // Serialize the DiffState to a plain object
        const serialized: SerializedDiffState = state
            ? {
                  kind: state.kind,
                  title: state.title,
                  targetUri: state.target.toString(),
                  targetPath: state.target.fsPath,
                  originalUri: state.original.toString(),
                  modifiedUri: state.modified.toString(),
              }
            : null;

        this.lastDiffState = serialized;

        const message: DiffStateMessage = {
            type: "diff-state",
            diffState: this.lastDiffState,
        };

        this.broadcast(message);
    }

    private broadcast(message: ServerMessage): void {
        const json = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
            }
        }
    }

    private sendToClient(client: WebSocket, message: ServerMessage): void {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    }

    private gatherContext(): IdeContextPayload {
        const workspace = vscode.workspace;
        const window = vscode.window;

        const editorByDoc = new Map(
            window.visibleTextEditors.map((editor) => [
                editor.document.uri.toString(),
                editor,
            ])
        );
        const openFiles = workspace.textDocuments.map((doc) => {
            const editor = editorByDoc.get(doc.uri.toString());
            const isActive =
                editor !== undefined && window.activeTextEditor === editor;
            const cursor = editor?.selection.active;
            const visibleRanges = editor?.visibleRanges ?? [];

            const selectedText = editor ? doc.getText(editor.selection) : "";
            const selection: SelectedText | undefined = selectedText
                ? {
                      text: selectedText,
                      startLine: editor!.selection.start.line + 1,
                      endLine: editor!.selection.end.line + 1,
                  }
                : undefined;
            let visibleText: { startLine: number; lines: string[] } | undefined;
            let visibleLineRange:
                | { startLine: number; endLine: number }
                | undefined;
            if (visibleRanges.length > 0) {
                const startLine = visibleRanges[0].start.line;
                let endLine = visibleRanges[0].end.line;
                if (
                    visibleRanges[0].end.character === 0 &&
                    endLine > startLine
                ) {
                    endLine -= 1;
                }
                visibleLineRange = {
                    startLine: startLine + 1,
                    endLine: endLine + 1,
                };
                visibleText = {
                    startLine: startLine + 1,
                    lines: doc.getText(visibleRanges[0]).split("\n"),
                };
            }

            return {
                path: doc.uri.fsPath,
                isActive,
                timestamp: Date.now(),
                cursor: cursor
                    ? {
                          line: cursor.line + 1,
                          character: cursor.character,
                      }
                    : undefined,
                selection,
                fullText: doc.getText(),
                visibleLineRange,
                visibleText,
            };
        });

        // Get all workspace files (simplified - could be enhanced)
        const workspaceFiles: string[] = [];
        // Note: For performance, we might not want to list ALL files every time
        // This is a simplified version - the actual implementation could use findFiles

        return {
            workspaceState: {
                isTrusted: workspace.isTrusted,
                openFiles,
                workspaceFiles,
            },
        };
    }
}
