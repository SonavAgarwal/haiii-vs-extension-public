import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { IDECurrentFileServer } from "./ide_current_file_server";
import { IDEWorkspaceServer } from "./ide_workspace_server";
import { IDENavigationServer } from "./ide_navigation_server";
import { CodeServer } from "./code_server";
import { ManualServer } from "./manual_server";
import { DiffManager } from "./diff_manager";
import { InlinePreviewManager } from "./inline_preview_manager";
import { InstantCodeServer } from "./instant_code_server";
import { WorkspaceContextServer } from "./workspace_context_server";
import { ContextWebSocketServer } from "./context_ws_server";
import { BackgroundAgentServer } from "./background_agent_server";
import dotenv from "dotenv";
import { initCurrentFileTracker } from "./current_file_tracker";

const TERMINAL_NAME = "Voice Coding";
const LEGACY_TERMINAL_NAME = "Voice Coding Agent";

let currentFileServer: IDECurrentFileServer | undefined;
let workspaceServer: IDEWorkspaceServer | undefined;
let navigationServer: IDENavigationServer | undefined;
let codeServer: CodeServer | undefined;
let manualServer: ManualServer | undefined;
let instantCodeServer: InstantCodeServer | undefined;
let workspaceContextServer: WorkspaceContextServer | undefined;
let backgroundAgentServer: BackgroundAgentServer | undefined;
let contextWsServer: ContextWebSocketServer | undefined;
let voiceCodingTerminal: vscode.Terminal | undefined;

export async function activate(context: vscode.ExtensionContext) {
	const out = vscode.window.createOutputChannel("Voice Coding IDE Companion");
	const log = (msg: string) => out.appendLine(`[vc] ${msg}`);
	context.subscriptions.push(out);

	// Track the last active real file so diff views don't steal context
	initCurrentFileTracker(context);

	// Load the client root from a local .env (set VOICE_CODING_CLIENT_ROOT there)
	const extensionRoot = context.extensionUri.fsPath;
	const extensionEnv =
		dotenv.config({ path: path.join(extensionRoot, ".env") }).parsed ?? {};
	const clientRoot = extensionEnv.VOICE_CODING_CLIENT_ROOT;

	const clientEnvConfig = clientRoot
		? dotenv.config({ path: path.join(clientRoot, ".env") })
		: { parsed: undefined };
	const clientEnv = clientEnvConfig.parsed;

	const diffManager = new DiffManager(context);
	const inlinePreviewManager = new InlinePreviewManager(context);

	// Start the WebSocket server for context and diff updates
	contextWsServer = new ContextWebSocketServer(log, context, diffManager);
	await contextWsServer.start();

	currentFileServer = new IDECurrentFileServer(log, context);
	await currentFileServer.start();
	workspaceServer = new IDEWorkspaceServer(log, context);
	await workspaceServer.start();
	navigationServer = new IDENavigationServer(log, context);
	await navigationServer.start();
	codeServer = new CodeServer(log, context, diffManager, inlinePreviewManager);
	await codeServer.start();
	manualServer = new ManualServer(
		log,
		context,
		diffManager,
		inlinePreviewManager
	);
	await manualServer.start();
	instantCodeServer = new InstantCodeServer(log, context);
	await instantCodeServer.start();
	backgroundAgentServer = new BackgroundAgentServer(log, context);
	await backgroundAgentServer.start();
	workspaceContextServer = new WorkspaceContextServer(log, context);
	await workspaceContextServer.start();

	// Optional: surface the port in an info message once
	const contextWsPort = contextWsServer.getPort();
	if (contextWsPort) log(`Context WebSocket server port is ${contextWsPort}`);
	const cfPort = currentFileServer.getPort();
	if (cfPort) log(`Current-file server port is ${cfPort}`);
	const wsPort = workspaceServer.getPort();
	if (wsPort) log(`Workspace server port is ${wsPort}`);
	const navPort = navigationServer.getPort();
	if (navPort) log(`Navigation server port is ${navPort}`);
	const codePort = codeServer.getPort();
	if (codePort) {
		log(`Code server port is ${codePort}`);
	}
	const manualPort = manualServer.getPort();
	if (manualPort) {
		log(`Manual server port is ${manualPort}`);
	}
	const instantPort = instantCodeServer.getPort();
	if (instantPort) {
		log(`Instant code server port is ${instantPort}`);
	}
	const backgroundPort = backgroundAgentServer.getPort();
	if (backgroundPort) {
		log(`Background agent server port is ${backgroundPort}`);
	}
	const workspaceContextPort = workspaceContextServer.getPort();
	if (workspaceContextPort) {
		log(`Workspace context server port is ${workspaceContextPort}`);
	}

	const resolveCliCommand = () => {
		const envCliPath = process.env["HAIII_CLI_PATH"]?.trim();
		const envDevClientRoot = process.env["HAIII_DEV_CLIENT_ROOT"]?.trim();

		if (context.extensionMode === vscode.ExtensionMode.Development) {
			if (envCliPath) {
				return {cmd: `"${envCliPath}"`, env: undefined};
			}

			const devRoot = envDevClientRoot || clientRoot;
			if (devRoot) {
				const cliScript = path.join(devRoot, "dist", "cli.js");
				if (!fs.existsSync(cliScript)) {
					return {
						error: `CLI entry not found at ${cliScript}. Build the CLI first.`,
					};
				}
				return {
					cmd: `"${process.execPath}" "${cliScript}"`,
					env: clientEnv,
				};
			}
		}

		return {cmd: "haiii", env: undefined};
	};

	// Command to run the voice-coding client in a VS Code terminal
	const runMyProgram = vscode.commands.registerCommand(
		"voice-coding-vscode-companion.startVoiceCoding",
		async () => {
			const resolved = resolveCliCommand();
			if ("error" in resolved) {
				vscode.window.showErrorMessage(resolved.error ?? "Unknown error.");
				return;
			}
			const cmd = resolved.cmd;

			// Prefer workspace root if present
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			voiceCodingTerminal =
				voiceCodingTerminal ??
				vscode.window.terminals.find(
					(t) => t.name === TERMINAL_NAME || t.name === LEGACY_TERMINAL_NAME
				);

			if (!voiceCodingTerminal) {
				voiceCodingTerminal = vscode.window.createTerminal({
					name: TERMINAL_NAME,
					cwd,
					env: resolved.env,
				});
			} else {
				// Interrupt any running process in the existing terminal before rerunning
				voiceCodingTerminal.sendText("\u0003", false);
			}

			voiceCodingTerminal.show();
			voiceCodingTerminal.sendText(cmd);
		}
	);

	context.subscriptions.push(runMyProgram);

	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminal === voiceCodingTerminal) {
				voiceCodingTerminal = undefined;
			}
		})
	);
}

export async function deactivate(): Promise<void> {
	try {
		if (contextWsServer) {
			await contextWsServer.stop();
			contextWsServer = undefined;
		}
		if (currentFileServer) {
			await currentFileServer.stop();
			currentFileServer = undefined;
		}
		if (workspaceServer) {
			await workspaceServer.stop();
			workspaceServer = undefined;
		}
		if (navigationServer) {
			await navigationServer.stop();
			navigationServer = undefined;
		}
		if (codeServer) {
			await codeServer.stop();
			codeServer = undefined;
		}
		if (manualServer) {
			await manualServer.stop();
			manualServer = undefined;
		}
		if (instantCodeServer) {
			await instantCodeServer.stop();
			instantCodeServer = undefined;
		}
		if (backgroundAgentServer) {
			await backgroundAgentServer.stop();
			backgroundAgentServer = undefined;
		}
		if (workspaceContextServer) {
			await workspaceContextServer.stop();
			workspaceContextServer = undefined;
		}
	} catch (e) {
		// best-effort shutdown
	}
}
