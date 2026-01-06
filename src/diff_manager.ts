import * as vscode from "vscode";

export type DiffKind = "modify" | "create" | "delete";

export type DiffDisplayMode = "diffView" | "inline";

export type DiffState = {
	kind: DiffKind;
	target: vscode.Uri;
	original: vscode.Uri;
	modified: vscode.Uri;
	title: string;
	focusLine?: number;
	displayMode: DiffDisplayMode;
};

export type DiffStateListener = (state: DiffState | undefined) => void;

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
	return a.toString() === b.toString();
}

function isDiffInput(input: unknown): input is vscode.TabInputTextDiff {
	return input instanceof vscode.TabInputTextDiff;
}

export class DiffManager {
	private current?: DiffState;
	private readonly listeners = new Set<DiffStateListener>();

	constructor(private readonly context: vscode.ExtensionContext) {
		const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
			this.reconcileCurrentState();
		});
		this.context.subscriptions.push(sub);
}

	getScratchDir(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, "code-diffs");
	}

	async ensureScratchDir(): Promise<vscode.Uri> {
		const dir = this.getScratchDir();
		try {
			await vscode.workspace.fs.createDirectory(dir);
		} catch {}
		return dir;
	}

	getCurrent(): DiffState | undefined {
		return this.current;
	}

	setCurrent(state: DiffState | undefined) {
		const previous = this.current;
		this.current = state;
		if (previous !== state) {
			this.notifyChange();
		}
	}

	clearCurrent() {
		if (!this.current) return;
		this.current = undefined;
		this.notifyChange();
	}

	onChange(listener: DiffStateListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyChange() {
		for (const listener of this.listeners) {
			try {
				listener(this.current);
			} catch (error) {
				console.error('DiffManager listener error', error);
			}
		}
	}

	private reconcileCurrentState() {
		if (!this.current) return;
		const state = this.current;
		if (state.displayMode === "inline") {
			return;
		}
		if (!this.isStateOpen(state)) {
			this.setCurrent(undefined);
		}
}

	private isStateOpen(state: DiffState): boolean {
		if (state.displayMode === "inline") {
			return true;
		}
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (!isDiffInput(input)) continue;
				if (
					sameUri(input.original, state.original) &&
					sameUri(input.modified, state.modified)
				) {
					return true;
				}
			}
		}
		return false;
	}

	private uriWithinScratch(uri: vscode.Uri, scratch: vscode.Uri): boolean {
		try {
			return (
				uri.scheme === scratch.scheme &&
				uri.toString().startsWith(scratch.toString())
			);
		} catch {
			return false;
		}
	}

	async closeAllDiffTabs(): Promise<void> {
		if (this.current?.displayMode === "inline") {
			this.clearCurrent();
			return;
		}
		const scratch = await this.ensureScratchDir();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (!isDiffInput(input)) continue;
				const ours =
					this.uriWithinScratch(input.original, scratch) ||
					this.uriWithinScratch(input.modified, scratch);
				if (!ours) continue;
				try {
					await vscode.window.tabGroups.close(tab, true);
				} catch {}
			}
		}
		this.clearCurrent();
	}
}
