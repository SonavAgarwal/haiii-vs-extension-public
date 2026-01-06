import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "mcp-zod";
import * as path from "node:path";
import * as vscode from "vscode";
import { BaseMcpHttpServer } from "./mcp_base";
import { DiffManager, DiffState } from "./diff_manager";
import { InlinePreviewManager } from "./inline_preview_manager";
import { setLastRealFileUri } from "./current_file_tracker";
import { MANUAL_SERVER_NAME } from "@voice-coding/shared-types";

const DIFF_STATE_NOTIFICATION_METHOD = "manual/diffState";

type ManualDiffStatePayload = {
    kind: DiffState["kind"];
    title: string;
    targetUri: string;
    targetPath: string;
    originalUri: string;
    modifiedUri: string;
    focusLine: number | null;
};

export class ManualServer extends BaseMcpHttpServer {
    constructor(
        log: (msg: string) => void,
        context: vscode.ExtensionContext,
        private readonly diffManager: DiffManager,
        private readonly inlinePreviewManager: InlinePreviewManager
    ) {
        super(MANUAL_SERVER_NAME, log, context);
    }

    private removeDiffListener?: () => void;

    protected override createMcpServer() {
        const server = new McpServer(
            { name: MANUAL_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );
        if (!this.removeDiffListener) {
            this.removeDiffListener = this.diffManager.onChange((state) => {
                this.emitDiffState(state);
            });
        }
        this.emitDiffState(this.diffManager.getCurrent());

        const ensureParentDirectory = async (target: vscode.Uri) => {
            const dirPath = path.dirname(target.fsPath);
            if (!dirPath) return;
            const dirUri = vscode.Uri.file(dirPath);
            try {
                await vscode.workspace.fs.createDirectory(dirUri);
            } catch {}
        };

        server.registerTool(
            "MANUAL_acceptDiff",
            {
                description:
                    "Apply the currently open diff created by this extension to the workspace file system.",
                inputSchema: z.object({}).shape,
            },
            async () => {
                const state = this.diffManager.getCurrent();
                if (!state) {
                    const msg = "No extension-managed diff is currently open.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                try {
                    let resultMsg: string;
                    switch (state.kind) {
                        case "modify":
                        case "create": {
                            const content = await vscode.workspace.fs.readFile(
                                state.modified
                            );
                            await ensureParentDirectory(state.target);
                            await vscode.workspace.fs.writeFile(
                                state.target,
                                content
                            );
                            setLastRealFileUri(state.target);
                            resultMsg =
                                state.kind === "create"
                                    ? `Created ${state.target.fsPath}`
                                    : `Updated ${state.target.fsPath}`;
                            break;
                        }
                        case "delete": {
                            await vscode.workspace.fs.delete(state.target, {
                                recursive: false,
                                useTrash: false,
                            });
                            resultMsg = `Deleted ${state.target.fsPath}`;
                            break;
                        }
                        default: {
                            resultMsg = "Unknown diff type.";
                            break;
                        }
                    }

                    await this.diffManager.closeAllDiffTabs();
                    this.inlinePreviewManager.clear(state.target);
                    const msg = `Applied diff: ${resultMsg}`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                } catch (e) {
                    const err = `Failed to apply diff: ${String(e)}`;
                    this.log(err);
                    return { content: [{ type: "text", text: err }] };
                }
            }
        );

        server.registerTool(
            "MANUAL_clearDiff",
            {
                description:
                    "Close the currently open diff created by this extension without applying changes.",
                inputSchema: z.object({}).shape,
            },
            async () => {
                const state = this.diffManager.getCurrent();
                if (!state) {
                    const msg = "No extension-managed diff is currently open.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }

                try {
                    await this.diffManager.closeAllDiffTabs();
                    this.inlinePreviewManager.clear(state.target);
                    const msg = `Cleared diff for ${state.target.fsPath}`;
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                } catch (e) {
                    const err = `Failed to clear diff: ${String(e)}`;
                    this.log(err);
                    return { content: [{ type: "text", text: err }] };
                }
            }
        );

        return server;
    }

    protected override async onAfterStreamConnected(
        transport: StreamableHTTPServerTransport
    ): Promise<void> {
        await super.onAfterStreamConnected(transport);
        this.emitDiffState(this.diffManager.getCurrent(), transport);
    }

    override async stop(): Promise<void> {
        this.removeDiffListener?.();
        this.removeDiffListener = undefined;
        await super.stop();
    }

    private diffStateToPayload(state: DiffState): ManualDiffStatePayload {
        return {
            kind: state.kind,
            title: state.title,
            targetUri: state.target.toString(),
            targetPath: state.target.fsPath,
            originalUri: state.original.toString(),
            modifiedUri: state.modified.toString(),
            focusLine: state.focusLine ?? null,
        };
    }

    private emitDiffState(
        state: DiffState | undefined,
        targetTransport?: StreamableHTTPServerTransport
    ): void {
        const notification = {
            jsonrpc: "2.0" as const,
            method: DIFF_STATE_NOTIFICATION_METHOD,
            params: {
                state: state ? this.diffStateToPayload(state) : null,
                timestamp: Date.now(),
            },
        };
        const transports = targetTransport
            ? [targetTransport]
            : Object.values(this.transports);
        for (const transport of transports) {
            try {
                transport.send(notification);
            } catch (error) {
                this.log(`Failed to broadcast diff state: ${String(error)}`);
            }
        }
    }
}
