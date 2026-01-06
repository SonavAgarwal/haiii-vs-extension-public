import * as vscode from "vscode";

let lastRealFileUri: vscode.Uri | undefined;

export function initCurrentFileTracker(context: vscode.ExtensionContext) {
  // Seed from current active editor
  const seed = vscode.window.activeTextEditor?.document.uri;
  if (seed && seed.scheme === "file") {
    lastRealFileUri = seed;
  }

  const sub1 = vscode.window.onDidChangeActiveTextEditor((ed) => {
    const uri = ed?.document?.uri;
    if (uri && uri.scheme === "file") {
      lastRealFileUri = uri;
    }
  });

  context.subscriptions.push(sub1);
}

export function setLastRealFileUri(uri: vscode.Uri | undefined) {
  if (uri && uri.scheme === "file") {
    lastRealFileUri = uri;
  }
}

export function getLastRealFileUri(): vscode.Uri | undefined {
  return lastRealFileUri;
}

export async function getEffectiveActiveTextDocument(): Promise<vscode.TextDocument | undefined> {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === "file") {
    return ed.document;
  }

  if (lastRealFileUri) {
    try {
      return await vscode.workspace.openTextDocument(lastRealFileUri);
    } catch {
      // fall through
    }
  }

  const anyVisible = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.scheme === "file"
  );
  return anyVisible?.document;
}

export function getEffectiveActiveTextEditor(): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === "file") {
    return ed;
  }

  if (lastRealFileUri) {
    const matching = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === lastRealFileUri!.toString()
    );
    if (matching) return matching;
  }

  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.scheme === "file"
  );
}

