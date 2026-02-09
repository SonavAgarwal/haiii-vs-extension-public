import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fuzzysort from "fuzzysort";
import { z } from "mcp-zod";
import * as vscode from "vscode";
import { WORKSPACE_FILE_EXCLUDES } from "./consts";
import { BaseMcpHttpServer } from "./mcp_base";
import { IDE_WORKSPACE_SERVER_NAME } from "@voice-coding/shared-types";

export class IDEWorkspaceServer extends BaseMcpHttpServer {
    constructor(log: (msg: string) => void, context: vscode.ExtensionContext) {
        super(IDE_WORKSPACE_SERVER_NAME, log, context);
    }

    protected createMcpServer() {
        const server = new McpServer(
            { name: IDE_WORKSPACE_SERVER_NAME, version: "0.0.1" },
            { capabilities: { logging: {} } },
        );

        server.registerTool(
            "searchForFileNames",
            {
                description:
                    "Fuzzy search for file names. This tool does not search file contents.",
                inputSchema: z.object({
                    words: z
                        .string()
                        .min(1)
                        .describe("Words or file name parts to search for"),
                }).shape,
            },
            async ({ words }: { words: string }) => {
                this.log(`Tool searchForFiles called with ${words}`);
                const roots = vscode.workspace.workspaceFolders;
                if (!roots || roots.length === 0) {
                    return {
                        content: [
                            { type: "text", text: "No workspace is open." },
                        ],
                    };
                }
                const allFiles = await vscode.workspace.findFiles(
                    "**/*",
                    WORKSPACE_FILE_EXCLUDES,
                    10000,
                );
                const results = fuzzysort
                    .go(words, allFiles, {
                        key: "fsPath",
                        limit: 10,
                        threshold: 0.1,
                    })
                    .map((r) => r.obj);

                const resultsText = [
                    `Found ${results.length} file(s) matching "${words}":`,
                    ...results.map((r) => `- ${r.fsPath ?? r}`),
                ].join("\n");

                this.log(resultsText);

                return {
                    content: [
                        {
                            type: "text",
                            text: resultsText,
                        },
                    ],
                };
            },
        );

        // server.registerTool(
        //     "readFile",
        //     {
        //         description:
        //             "Read a file from the workspace by URI or absolute path.",
        //         inputSchema: z.object({
        //             filePath: z
        //                 .string()
        //                 .describe("file:// URI or absolute path"),
        //         }).shape,
        //     },
        //     async ({ filePath }: { filePath: string }) => {
        //         this.log(`Tool readFile called with ${filePath}`);
        //         let uri: vscode.Uri;
        //         try {
        //             uri = filePath.startsWith("file://")
        //                 ? vscode.Uri.parse(filePath)
        //                 : vscode.Uri.file(filePath);
        //         } catch {
        //             return {
        //                 content: [
        //                     { type: "text", text: `Invalid path: ${filePath}` },
        //                 ],
        //             };
        //         }
        //         try {
        //             const buf = await vscode.workspace.fs.readFile(uri);
        //             const text = Buffer.from(buf).toString("utf8");
        //             const limit = 20000;
        //             const out =
        //                 text.length > limit
        //                     ? text.slice(0, limit) +
        //                       `\n\n... (truncated, total ${text.length} chars)`
        //                     : text;
        //
        //             this.log(`Read file ${filePath} with ${out.length} chars`);
        //             return { content: [{ type: "text", text: out }] };
        //         } catch (e) {
        //             return {
        //                 content: [
        //                     {
        //                         type: "text",
        //                         text: `Failed to read ${filePath}: ${String(
        //                             e
        //                         )}`,
        //                     },
        //                 ],
        //             };
        //         }
        //     }
        // );

        server.registerTool(
            "listDirectory",
            {
                description:
                    "List files and folders in a given directory. Returns names with a trailing / for directories.",
                inputSchema: z.object({
                    path: z
                        .string()
                        .min(1)
                        .describe("Absolute path to the directory to list"),
                }).shape,
            },
            async ({ path }: { path: string }) => {
                this.log(`Tool listDirectory called with ${path}`);
                let uri: vscode.Uri;
                try {
                    uri = vscode.Uri.file(path);
                } catch {
                    return {
                        content: [
                            { type: "text", text: `Invalid path: ${path}` },
                        ],
                    };
                }
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if (stat.type !== vscode.FileType.Directory) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `${path} is a file, not a directory. Use showFile to read it.`,
                                },
                            ],
                        };
                    }
                    const entries =
                        await vscode.workspace.fs.readDirectory(uri);
                    const lines = entries.map(([name, type]) =>
                        type === vscode.FileType.Directory ? `${name}/` : name,
                    );
                    const text =
                        lines.length > 0
                            ? lines.join("\n")
                            : "(empty directory)";
                    return { content: [{ type: "text", text }] };
                } catch (e) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to list ${path}: ${String(e)}`,
                            },
                        ],
                    };
                }
            },
        );

        return server;
    }
}
