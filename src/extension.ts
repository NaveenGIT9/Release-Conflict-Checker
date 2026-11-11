import * as vscode from 'vscode';
import { ReleaseCheckerPanel } from './panels/ReleaseCheckerPanel';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(key: string, content: string): void {
    const stale = this.cache.has(key) && this.cache.get(key) !== content;
    this.cache.set(key, content);
    if (stale) this.changed.fire(vscode.Uri.parse(key));
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
