import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fuzzysort from "fuzzysort";
import { z } from "mcp-zod";
import * as vscode from "vscode";
import { getEffectiveActiveTextDocument } from "./current_file_tracker";
import { FilesManager } from "./files_manager";
import { BaseMcpHttpServer } from "./mcp_base";
import { IDE_CURRENT_FILE_SERVER_NAME } from "@voice-coding/shared-types";

export class IDECurrentFileServer extends BaseMcpHttpServer {
    private openFilesManager?: FilesManager;

    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(IDE_CURRENT_FILE_SERVER_NAME, log, context);
    }

    protected createMcpServer() {
        const server = new McpServer(
            { name: IDE_CURRENT_FILE_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } }
        );

        // Moved from CodeServer
        server.registerTool(
            "readCurrentFile",
            {
                description: "Read the entire text of the currently open file.",
                inputSchema: z.object({
                    numbered: z
                        .boolean()
                        .optional()
                        .describe(
                            "If true, prefix each line with its line number. Defaults to true."
                        ),
                }).shape,
            },
            async (opts: { numbered?: boolean } = { numbered: true }) => {
                this.log("Tool readCurrentFile called");
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open to read.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                const text = doc.getText();
                const limit = 10000;
                const limitedText =
                    text.length > limit
                        ? text.slice(0, limit) +
                          `\n\n... (truncated, total ${text.length} chars)`
                        : text;
                const lines = limitedText.split(/\r\n|\r|\n/);
                const numberedLines = opts.numbered
                    ? lines.map((line, idx) => `${idx + 1}:${line}`)
                    : lines;
                const finalText = numberedLines.join("\n");
                this.log(`Read current file with ${finalText.length} chars`);
                return { content: [{ type: "text", text: finalText }] };
            }
        );

        server.registerTool(
            "searchCurrentFileText",
            {
                description:
                    "Search text in the CURRENTLY OPEN FILE and return matching line numbers and contents in the current file.",
                inputSchema: z.object({
                    query: z
                        .string()
                        .min(1)
                        .describe("Text to search for in the current file"),
                }).shape,
            },
            async ({ query }: { query: string }) => {
                this.log(
                    `Tool searchCurrentFileText called with query: ${query}`
                );
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open to search.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                const text = doc.getText();
                const lines = text.split(/\r?\n/);
                const items = lines.map((t, i) => ({ text: t, line: i + 1 }));
                const fuzzyMatches = fuzzysort.go<{
                    text: string;
                    line: number;
                }>(query, items, {
                    key: "text",
                    limit: 10,
                    threshold: -200,
                });
                const contextRadius = 3;
                const matches = fuzzyMatches.map((result) => {
                    const { line } = result.obj;
                    const centerIndex = line - 1;
                    const startIndex = Math.max(0, centerIndex - contextRadius);
                    const endIndex = Math.min(
                        lines.length - 1,
                        centerIndex + contextRadius
                    );
                    const snippet = [] as string[];
                    for (let i = startIndex; i <= endIndex; i += 1) {
                        snippet.push(`${i + 1}:${lines[i]}`);
                    }
                    return {
                        line,
                        startLine: startIndex + 1,
                        endLine: endIndex + 1,
                        snippet,
                    };
                });
                const bodyLines: string[] = [
                    `Found ${matches.length} match(es) for "${query}":`,
                ];
                for (const match of matches) {
                    const rangeLabel =
                        match.startLine === match.endLine
                            ? `line ${match.startLine}`
                            : `lines ${match.startLine}-${match.endLine}`;
                    bodyLines.push(
                        `- ${rangeLabel} (match at line ${match.line})`
                    );
                    for (const snippetLine of match.snippet) {
                        bodyLines.push(`  ${snippetLine}`);
                    }
                }
                const body = bodyLines.join("\n");
                this.log(body);
                return { content: [{ type: "text", text: body }] };
            }
        );

        server.registerTool(
            "readCurrentFileSymbols",
            {
                description: "Read the symbols in the currently open file.",
                inputSchema: z.object({}).shape,
            },
            async () => {
                this.log("Tool readCurrentFileSymbols called");
                const doc = await getEffectiveActiveTextDocument();
                if (!doc || doc.uri.scheme !== "file") {
                    const msg = "No active file is open to read.";
                    this.log(msg);
                    return { content: [{ type: "text", text: msg }] };
                }
                const uri = doc.uri;
                const symbols = (await vscode.commands.executeCommand(
                    "vscode.executeDocumentSymbolProvider",
                    uri
                )) as vscode.DocumentSymbol[] | undefined;
                if (!symbols) {
                    const msg = `No symbols found in ${uri.fsPath}`;
                    return { content: [{ type: "text", text: msg }] };
                }
                const lines: string[] = [];
                function printSymbols(
                    syms: vscode.DocumentSymbol[],
                    indent: string
                ) {
                    for (const sym of syms) {
                        lines.push(
                            `${indent}- ${sym.name} (${sym.kind.toString()}) [${
                                sym.range.start.line + 1
                            }:${sym.range.start.character + 1} - ${
                                sym.range.end.line + 1
                            }:${sym.range.end.character + 1}]`
                        );
                        if (sym.children && sym.children.length > 0) {
                            printSymbols(sym.children, indent + "  ");
                        }
                    }
                }
                printSymbols(symbols, "");
                this.log(`Read ${lines.length} symbols from current file`);
                return { content: [{ type: "text", text: lines.join("\n") }] };
            }
        );

        return server;
    }

    private async sendIdeContextUpdate(
        transport: StreamableHTTPServerTransport
    ) {
        if (!this.openFilesManager) return;
        const payload = await this.openFilesManager.state();
        const notification = {
            jsonrpc: "2.0" as const,
            method: "ide/contextUpdate",
            params: payload,
        };
        try {
            transport.send(notification);
        } catch (e) {
            this.log(`Failed to send ide/contextUpdate: ${String(e)}`);
        }
    }

    override async start(): Promise<void> {
        if (this.server) return;
        this.openFilesManager = new FilesManager(this.context.subscriptions);
        const ctxSub = this.openFilesManager.onDidChange(async () => {
            for (const t of Object.values(this.transports)) {
                await this.sendIdeContextUpdate(t);
            }
        });
        this.context.subscriptions.push(ctxSub);
        await super.start();
    }

    protected override async onAfterStreamConnected(
        transport: StreamableHTTPServerTransport
    ) {
        await this.sendIdeContextUpdate(transport);
    }

    protected override async onAfterPostHandled(
        transport: StreamableHTTPServerTransport
    ) {
        await this.sendIdeContextUpdate(transport);
    }
}
