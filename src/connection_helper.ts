import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { DEFAULT_REGISTRY_FILENAME, REGISTRY_ENV } from "./consts";

export type ServerRecord = {
	name: string;
	port: number;
	workspacePath: string;
	ppid: number;
	startedAt: string; // ISO-8601
};

export type ServerRegistry = {
	updatedAt: string;
	servers: Record<string, ServerRecord>;
};

function defaultRegistryPath(): string {
	return path.join(os.tmpdir(), DEFAULT_REGISTRY_FILENAME);
}

async function readRegistry(
	registryPath: string
): Promise<ServerRegistry | null> {
	try {
		const buf = await fs.readFile(registryPath, "utf8");
		const json = JSON.parse(buf);
		if (json && typeof json.servers === "object") {
			return {
				updatedAt:
					typeof json.updatedAt === "string"
						? json.updatedAt
						: new Date().toISOString(),
				servers: json.servers as Record<string, ServerRecord>,
			};
		}
	} catch {
		// file may not exist / be empty / invalid
	}
	return null;
}

async function atomicWrite(registryPath: string, data: unknown): Promise<void> {
	const tmp = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
	const payload = JSON.stringify(data, null, 2);
	await fs.writeFile(tmp, payload, "utf8");
	await fs.rename(tmp, registryPath);
}

export async function registerServer(opts: {
	context: vscode.ExtensionContext;
	name: string;
	port: number;
	workspacePath: string;
	ppid?: number; // defaults to process.ppid
	registryPath?: string;
}): Promise<string> {
	const {
		context,
		name,
		port,
		workspacePath,
		ppid = process.ppid,
		registryPath = defaultRegistryPath(),
	} = opts;

	const now = new Date().toISOString();
	const existing = (await readRegistry(registryPath)) ?? {
		updatedAt: now,
		servers: {},
	};

	existing.servers[name] = {
		name,
		port,
		workspacePath,
		ppid,
		startedAt: existing.servers[name]?.startedAt ?? now,
	};
	existing.updatedAt = now;

	await atomicWrite(registryPath, existing);

	// Make discoverable to NEW terminals
	context.environmentVariableCollection.replace(REGISTRY_ENV, registryPath);
	return registryPath;
}

export async function unregisterServer(opts: {
	context: vscode.ExtensionContext;
	name: string;
	registryPath?: string;
}): Promise<void> {
	const { context, name, registryPath = defaultRegistryPath() } = opts;

	const existing = await readRegistry(registryPath);
	if (!existing) {
		// nothing to do
	} else {
		delete existing.servers[name];
		existing.updatedAt = new Date().toISOString();

		if (Object.keys(existing.servers).length === 0) {
			// last one; remove entire file
			try {
				await fs.unlink(registryPath);
			} catch {
				/* ignore */
			}
			// also clear the registry env var
			context.environmentVariableCollection.replace(REGISTRY_ENV, "");
		} else {
			await atomicWrite(registryPath, existing);
			// keep REGISTRY_ENV pointing at the file
			context.environmentVariableCollection.replace(REGISTRY_ENV, registryPath);
		}
	}
}
