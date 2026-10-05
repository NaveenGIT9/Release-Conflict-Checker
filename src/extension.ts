import * as vscode from 'vscode';
import { ReleaseCheckerPanel } from './panels/ReleaseCheckerPanel';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();

  set(key: string, content: string): void {
    this.cache.set(key, content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? '';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const gitProvider = new GitContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('sfconflict', gitProvider)
  );
  ReleaseCheckerPanel.gitProvider = gitProvider;

  context.subscriptions.push(
    vscode.commands.registerCommand('sf-release-conflict-checker.open', () => {
      ReleaseCheckerPanel.createOrShow(context.extensionUri, context);
    })
  );
}

export function deactivate(): void {}
