import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { type Server as HTTPServer } from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerServer, unregisterServer } from "./connection_helper";
import { MCP_SESSION_ID_HEADER } from "./consts";

export abstract class BaseMcpHttpServer {
	protected server?: HTTPServer;
	protected transports: Record<string, StreamableHTTPServerTransport> = {};
	protected app = express();
	protected port?: number;

	constructor(
		protected readonly name: string,
		protected readonly log: (msg: string) => void,
		protected readonly context: vscode.ExtensionContext
	) {
		this.app.use(express.json({ limit: "10mb" }));
	}

	protected abstract createMcpServer(): McpServer;

	protected async onAfterStreamConnected(
		_transport: StreamableHTTPServerTransport
	): Promise<void> {}

	protected async onAfterPostHandled(
		_transport: StreamableHTTPServerTransport
	): Promise<void> {}

	async start(): Promise<void> {
		if (this.server) return;

		const mcpServer = this.createMcpServer();

		// GET /mcp — streaming
		this.app.get("/mcp", async (req: Request, res: Response) => {
			const sid = req.headers[MCP_SESSION_ID_HEADER] as string | undefined;
			if (!sid || !this.transports[sid]) {
				res.status(400).send("Invalid or missing session ID");
				return;
			}
			const transport = this.transports[sid];
			try {
				await transport.handleRequest(req, res);
				try {
					await this.onAfterStreamConnected(transport);
				} catch (e) {
					this.log(`onAfterStreamConnected failed: ${String(e)}`);
				}
			} catch (e) {
				this.log(`GET /mcp error: ${String(e)}`);
				if (!res.headersSent) res.status(400).send("Bad Request");
			}
		});

		// POST /mcp — JSON-RPC over HTTP
		this.app.post("/mcp", async (req: Request, res: Response) => {
			const sid = req.headers[MCP_SESSION_ID_HEADER] as string | undefined;
			let transport: StreamableHTTPServerTransport;

			if (sid && this.transports[sid]) {
				transport = this.transports[sid];
			} else if (!sid && isInitializeRequest(req.body)) {
				transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (newSid) => {
						this.log(`New ${this.name} MCP session: ${newSid}`);
						this.transports[newSid] = transport;
					},
				});

				const keepAlive = setInterval(() => {
					try {
						transport.send({ jsonrpc: "2.0", method: "ping" });
					} catch {
						clearInterval(keepAlive);
					}
				}, 60_000);

				transport.onclose = () => {
					clearInterval(keepAlive);
					if (transport.sessionId) {
						delete this.transports[transport.sessionId];
						this.log(`Session closed: ${transport.sessionId}`);
					}
				};

				mcpServer.connect(transport);
			} else {
				res.status(400).json({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Bad Request: missing or invalid session",
					},
					id: null,
				});
				return;
			}

			try {
				await transport.handleRequest(req, res, req.body);
				try {
					await this.onAfterPostHandled(transport);
				} catch (e) {
					this.log(`onAfterPostHandled failed: ${String(e)}`);
				}
			} catch (e) {
				this.log(`POST /mcp error: ${String(e)}`);
				if (!res.headersSent) {
					res.status(500).json({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal server error" },
						id: null,
					});
				}
			}
		});

		// start server
		this.server = await new Promise<HTTPServer>((resolve) => {
			const http = this.app.listen(0, () => resolve(http));
		});

		const address = this.server.address();
		if (address && typeof address !== "string") {
			this.port = address.port;
			this.log(`${this.name} listening on port ${this.port}`);

			// Register in the shared registry JSON
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const workspacePath =
				workspaceFolders && workspaceFolders.length > 0
					? workspaceFolders.map((f) => f.uri.fsPath).join(path.delimiter)
					: "";

			await registerServer({
				context: this.context,
				name: this.name,
				port: this.port,
				workspacePath,
			});
		} else {
			this.log(`${this.name} listening`);
		}
	}

	getPort(): number | undefined {
		return this.port;
	}

	async stop(): Promise<void> {
		// Unregister from the shared registry
		await unregisterServer({ context: this.context, name: this.name });

		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
		this.port = undefined;
		this.transports = {};
	}
}
