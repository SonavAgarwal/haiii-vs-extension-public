import * as vscode from "vscode";

type InlinePreviewKind = "replace" | "insert" | "delete";

type InlinePreviewState = {
	kind: InlinePreviewKind;
	uri: string;
	range: vscode.Range;
	newText: string;
};

export class InlinePreviewManager {
	private current?: InlinePreviewState;
	private readonly removalDecoration: vscode.TextEditorDecorationType;
	private readonly insertionDecoration: vscode.TextEditorDecorationType;

	constructor(context: vscode.ExtensionContext) {
		this.removalDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor(
				"diffEditor.removedLineBackground"
			),
			border: "1px dashed rgba(220, 50, 47, 0.6)",
			isWholeLine: false,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		this.insertionDecoration = vscode.window.createTextEditorDecorationType({
			borderWidth: "0 0 0 2px",
			borderStyle: "solid",
			borderColor: new vscode.ThemeColor("diffEditor.insertedTextBorder"),
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		context.subscriptions.push(
			this.removalDecoration,
			this.insertionDecoration
		);

		const provider: vscode.InlineCompletionItemProvider = {
			provideInlineCompletionItems: (document, position) => {
				const preview = this.current;
				if (!preview) return;
				if (document.uri.toString() !== preview.uri) return;
				if (preview.kind === "delete") return;
				if (!position.isEqual(preview.range.start)) return;
				const item = new vscode.InlineCompletionItem(
					preview.newText,
					preview.range
				);
				return { items: [item] };
			},
		};
		const disposable = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**/*" },
			provider
		);
		context.subscriptions.push(disposable);

		context.subscriptions.push(
			vscode.window.onDidChangeVisibleTextEditors(() => {
				this.refreshDecorations();
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (this.current && document.uri.toString() === this.current.uri) {
					this.clear();
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.current && event.document.uri.toString() === this.current.uri) {
					this.clear();
				}
			})
		);
	}

	async showReplacement(
		doc: vscode.TextDocument,
		range: vscode.Range,
		newText: string
	) {
		this.current = {
			kind: "replace",
			uri: doc.uri.toString(),
			range,
			newText,
		};
		await this.present(doc, range, true);
	}

	async showInsertion(
		doc: vscode.TextDocument,
		position: vscode.Position,
		newText: string
	) {
		const range = new vscode.Range(position, position);
		this.current = {
			kind: "insert",
			uri: doc.uri.toString(),
			range,
			newText,
		};
		await this.present(doc, range, true);
	}

	async showDeletion(doc: vscode.TextDocument, range: vscode.Range) {
		this.current = {
			kind: "delete",
			uri: doc.uri.toString(),
			range,
			newText: "",
		};
		await this.present(doc, range, false);
	}

	clear(uri?: vscode.Uri) {
		if (uri && this.current && this.current.uri !== uri.toString()) {
			return;
		}
		if (!this.current) return;
		this.current = undefined;
		this.refreshDecorations();
		void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
	}

	private async present(
		doc: vscode.TextDocument,
		range: vscode.Range,
		showInlineSuggestion: boolean
	) {
		const editor = await vscode.window.showTextDocument(doc, {
			selection: new vscode.Selection(range.start, range.start),
		});
		editor.revealRange(
			range,
			vscode.TextEditorRevealType.InCenterIfOutsideViewport
		);
		this.refreshDecorations();
		await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		if (showInlineSuggestion) {
			await vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger"
			);
		}
	}

	private refreshDecorations() {
		for (const editor of vscode.window.visibleTextEditors) {
			const matches =
				this.current &&
				editor.document.uri.toString() === this.current.uri
					? this.current
					: undefined;
			if (!matches) {
				editor.setDecorations(this.removalDecoration, []);
				editor.setDecorations(this.insertionDecoration, []);
				continue;
			}
			if (matches.kind === "replace" || matches.kind === "delete") {
				editor.setDecorations(this.removalDecoration, [
					{ range: matches.range },
				]);
				editor.setDecorations(this.insertionDecoration, []);
			} else {
				editor.setDecorations(this.removalDecoration, []);
				editor.setDecorations(this.insertionDecoration, [
					{ range: matches.range },
				]);
			}
		}
	}
}
