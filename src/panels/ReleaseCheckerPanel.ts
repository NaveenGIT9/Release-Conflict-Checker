import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { GitContentProvider } from '../extension';

// ─── Debug log ────────────────────────────────────────────────────────────────

let _out: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!_out) _out = vscode.window.createOutputChannel('SF Release Checker');
  _out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SfRecord { [key: string]: string }

interface Story {
  id: string;
  name: string;
  baseBranch: string;
  featureBranch: string; // e.g. "feature/US-0030781"
  branchUrl: string;     // full GitHub URL for the feature branch (may be empty)
  releaseName?: string;  // which future planned release this story belongs to
}

interface CommonComponent {
  name: string;
  type: string;
  excludeStories: Story[]; // Release-to-Exclude stories that touched this component
}

// ─── Metadata type → file path mapping ───────────────────────────────────────

function getFilePath(name: string, type: string): string {
  const base = 'force-app/main/default';
  switch (type) {
    case 'ApexClass':              return `${base}/classes/${name}.cls`;
    case 'ApexTrigger':            return `${base}/triggers/${name}.trigger`;
    case 'Flow':                   return `${base}/flows/${name}.flow-meta.xml`;
    case 'PermissionSet':          return `${base}/permissionsets/${name}.permissionset-meta.xml`;
    case 'PermissionSetGroup':     return `${base}/permissionsetgroups/${name}.permissionsetgroup-meta.xml`;
    case 'Profile':                return `${base}/profiles/${name}.profile-meta.xml`;
    case 'LightningComponentBundle': return `${base}/lwc/${name}/${name}.js`;
    case 'AuraDefinitionBundle':   return `${base}/aura/${name}/${name}.cmp`;
    case 'Layout':                 return `${base}/layouts/${name}.layout-meta.xml`;
    case 'FlexiPage':              return `${base}/flexipages/${name}.flexipage-meta.xml`;
    case 'ApexPage':               return `${base}/pages/${name}.page`;
    case 'GlobalValueSet':         return `${base}/globalValueSets/${name}.globalValueSet-meta.xml`;
    case 'StandardValueSet':       return `${base}/standardValueSets/${name}.standardValueSet-meta.xml`;
    case 'ConnectedApp':           return `${base}/connectedApps/${name}.connectedApp-meta.xml`;
    case 'NamedCredential':        return `${base}/namedCredentials/${name}.namedCredential-meta.xml`;
    case 'CustomMetadata':         return `${base}/customMetadata/${name}.md-meta.xml`;
    case 'Queue':                  return `${base}/queues/${name}.queue-meta.xml`;
    case 'Role':                   return `${base}/roles/${name}.role-meta.xml`;
    case 'CustomObject': {
      return `${base}/objects/${name}/${name}.object-meta.xml`;
    }
    case 'CustomField': {
      // API name format: Object__c.Field__c
      const [obj, field] = name.split('.');
      return `${base}/objects/${obj}/fields/${field}.field-meta.xml`;
    }
    case 'ValidationRule': {
      // API name format: Object__c.RuleName
      const [obj, rule] = name.split('.');
      return `${base}/objects/${obj}/validationRules/${rule}.validationRule-meta.xml`;
    }
    case 'RecordType': {
      const [obj, rt] = name.split('.');
      return `${base}/objects/${obj}/recordTypes/${rt}.recordType-meta.xml`;
    }
    case 'CustomTab':              return `${base}/tabs/${name}.tab-meta.xml`;
    case 'ApexComponent':          return `${base}/components/${name}.component`;
    case 'StaticResource':         return `${base}/staticresources/${name}.resource-meta.xml`;
    default:                       return `${base}/${name}`;
  }
}

// ─── Extract branch name from Copado View-in-Git URL ─────────────────────────

function extractBranch(viewInGitUrl: string): string {
  if (!viewInGitUrl) return '';
  // copado__View_in_Git__c may be:
  //  (a) a plain URL:  https://github.com/.../tree/feature/US-xxx
  //  (b) a full anchor: <a href="https://...tree/feature/US-xxx" target="_blank">...</a>
  //  (c) a partial anchor (Salesforce strips the opening tag via API):
  //      https://github.com/.../tree/feature/US-xxx" target="_blank">feature/US-xxx</a>
  // Strategy: find /tree/, take everything after it, then cut at the first HTML char (" ' < >).
  const hrefMatch = viewInGitUrl.match(/href=["']([^"']+)["']/i);
  const url = hrefMatch ? hrefMatch[1] : viewInGitUrl;
  const treeIdx = url.indexOf('/tree/');
  if (treeIdx !== -1) {
    const raw = url.slice(treeIdx + 6);
    const htmlStart = raw.search(/["'<>]/);
    return htmlStart !== -1 ? raw.slice(0, htmlStart) : raw;
  }
  // Fallback: strip any HTML tags/attributes and return plain text
  return url.replace(/<[^>]+>/g, '').replace(/["'][^]*$/, '').trim();
}

// Returns the full clean GitHub URL for the feature branch (e.g. https://github.com/.../tree/feature/US-xxx)
function extractBranchUrl(viewInGitUrl: string): string {
  if (!viewInGitUrl) return '';
  const hrefMatch = viewInGitUrl.match(/href=["']([^"']+)["']/i);
  let url = hrefMatch ? hrefMatch[1] : viewInGitUrl;
  // Trim trailing HTML attributes
  const htmlStart = url.search(/["'<>]/);
  if (htmlStart !== -1) url = url.slice(0, htmlStart);
  return url.startsWith('http') ? url : '';
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitFileContent(branch: string, filePath: string, repoPath: string): string {
  // Try local branch first, then origin/
  for (const ref of [branch, `origin/${branch}`]) {
    const r = spawnSync('git', ['show', `${ref}:${filePath}`], {
      cwd: repoPath, encoding: 'utf8', shell: false,
    });
    if (r.status === 0) return r.stdout;
  }
  return ''; // file not found in either ref — treat as empty (new file in that branch)
}

function gitFetchBranch(branch: string, repoPath: string): void {
  spawnSync('git', ['fetch', 'origin', branch], {
    cwd: repoPath, encoding: 'utf8', shell: false,
  });
}

// Returns the merge base commit between baseBranch and featureBranch.
// This is the common ancestor — the point where the feature branch diverged.
// Using merge-base as the left side of the diff matches GitHub PR behaviour (three-dot diff).
function gitMergeBase(baseBranch: string, featureBranch: string, repoPath: string): string {
  for (const [b, f] of [
    [baseBranch, featureBranch],
    [`origin/${baseBranch}`, `origin/${featureBranch}`],
    [baseBranch, `origin/${featureBranch}`],
  ]) {
    const r = spawnSync('git', ['merge-base', b, f], {
      cwd: repoPath, encoding: 'utf8', shell: false,
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return baseBranch; // fallback: use base branch tip if merge-base fails
}

function gitFileContentAtRef(ref: string, filePath: string, repoPath: string): string {
  const r = spawnSync('git', ['show', `${ref}:${filePath}`], {
    cwd: repoPath, encoding: 'utf8', shell: false,
  });
  return r.status === 0 ? r.stdout : '';
}

function gitBranchExists(branch: string, repoPath: string): boolean {
  for (const ref of [`origin/${branch}`, branch]) {
    const r = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoPath, encoding: 'utf8', shell: false,
    });
    if (r.status === 0) return true;
  }
  return false;
}

// ─── Detect default SF org ────────────────────────────────────────────────────

function getDefaultSfOrg(): string {
  const sfArgs = ['config', 'get', 'target-org', '--json'];
  const [exe, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'sf', ...sfArgs]] as const
    : ['sf', sfArgs] as const;
  const r = spawnSync(exe, args, { encoding: 'utf8', shell: false, timeout: 10_000 });
  if (r.status === 0) {
    try {
      const parsed = JSON.parse(r.stdout) as { result?: Array<{ value?: string }> };
      const val = parsed?.result?.[0]?.value ?? '';
      return val;
    } catch { /* ignore */ }
  }
  return '';
}

// ─── SF query via CLI ─────────────────────────────────────────────────────────

function queryOrg(soql: string, orgAlias: string): SfRecord[] {
  const sfArgs = ['data', 'query', '--query', soql, '--target-org', orgAlias, '--json'];
  // On Windows, sf is a .cmd batch file and cannot be spawned directly without a shell.
  // Using cmd /c lets Node.js quote each argument via CreateProcess so spaces in SOQL stay intact.
  const [exe, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'sf', ...sfArgs]] as const
    : ['sf', sfArgs] as const;

  log(`Spawn: ${exe} ${args.join(' ')}`);
  const r = spawnSync(exe, args, { encoding: 'utf8', shell: false, timeout: 60_000 });
  log(`Exit: ${r.status ?? 'null'} | error: ${r.error?.message ?? 'none'}`);
  log(`stdout: ${(r.stdout ?? '').slice(0, 800)}`);
  log(`stderr: ${(r.stderr ?? '').slice(0, 400)}`);

  if (r.error) throw new Error(`Failed to launch sf: ${r.error.message}`);
  // With --json, sf always writes the response as JSON to stdout even when it
  // exits non-zero due to unrelated warnings (ESM plugin, update notices in stderr).
  // Parse stdout first; only treat it as an error if the JSON itself says so.
  try {
    const parsed = JSON.parse(r.stdout) as { status?: number; result?: { records?: SfRecord[] }; message?: string };
    if (parsed?.result?.records !== undefined) return parsed.result.records;
    if (parsed?.message) throw new Error(parsed.message);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  throw new Error(r.stderr || r.stdout || `SF query failed (exit ${r.status})`);
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export class ReleaseCheckerPanel {
  public static currentPanel: ReleaseCheckerPanel | undefined;
  public static gitProvider: GitContentProvider;
  public static context: vscode.ExtensionContext | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private orgAlias = '';
  private orgInstanceUrl = '';

  public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
    ReleaseCheckerPanel.context = context;
    if (ReleaseCheckerPanel.currentPanel) {
      ReleaseCheckerPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sfReleaseConflictChecker',
      'Release Conflict Checker',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ReleaseCheckerPanel.currentPanel = new ReleaseCheckerPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
    this.panel = panel;
    // Pre-fill: saved alias first, fall back to sf config default org
    const saved    = ReleaseCheckerPanel.context?.globalState.get<string>('lastOrgAlias') ?? '';
    const detected = saved || getDefaultSfOrg();
    this.orgAlias  = detected;
    this.panel.webview.html = this.getHtml(detected);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private post(data: Record<string, unknown>): void {
    void this.panel.webview.postMessage(data);
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.command) {
      case 'fetchReleases':
        await this.fetchReleases(msg.orgAlias as string);
        break;
      case 'analyseReleases':
        await this.analyseReleases(
          msg.promoteIds as string[],
          msg.excludeIds as string[],
          msg.excludeNames as string[]
        );
        break;
      case 'analyseStories':
        await this.analyseStories(msg.story1 as string, msg.story2 as string);
        break;
      case 'viewDiff':
        await this.openDiff(
          msg.storyName as string,
          msg.baseBranch as string,
          extractBranch(msg.featureBranch as string), // re-sanitise in case webview cached dirty value
          msg.componentName as string,
          msg.componentType as string
        );
        break;
      case 'openUrl':
        void vscode.env.openExternal(vscode.Uri.parse(msg.url as string));
        break;
    }
  }

  // ── Fetch releases from org ─────────────────────────────────────────────────

  private async fetchReleases(orgAlias: string): Promise<void> {
    this.orgAlias = orgAlias;
    void ReleaseCheckerPanel.context?.globalState.update('lastOrgAlias', orgAlias);
    this.post({ type: 'status', message: `Connecting to org: ${orgAlias}…` });
    try {
      // Get instance URL for clickable story links
      const sfArgs = ['org', 'display', '--target-org', orgAlias, '--json'];
      const [exe, dargs] = process.platform === 'win32'
        ? ['cmd', ['/c', 'sf', ...sfArgs]] as const
        : ['sf', sfArgs] as const;
      const dr = spawnSync(exe, dargs, { encoding: 'utf8', shell: false, timeout: 15_000 });
      if (dr.status === 0) {
        try {
          const dp = JSON.parse(dr.stdout) as { result?: { instanceUrl?: string } };
          this.orgInstanceUrl = dp?.result?.instanceUrl ?? '';
        } catch { /* ignore */ }
      }

      const records = queryOrg(
        'SELECT Id, Name, copado__Status__c FROM copado__Release__c ORDER BY Name LIMIT 500',
        orgAlias
      );

      // Fetch story counts per release via aggregate query
      const storyCountMap = new Map<string, number>();
      if (records.length > 0) {
        try {
          const ids = records.map(r => `'${r['Id']}'`).join(',');
          const countRecs = queryOrg(
            `SELECT copado__Release__c rid, COUNT(Id) cnt FROM copado__User_Story__c WHERE copado__Release__c IN (${ids}) GROUP BY copado__Release__c`,
            orgAlias
          );
          for (const cr of countRecs) {
            const rid = cr['rid'] ?? cr['copado__Release__c'] ?? '';
            const cnt = parseInt(String(cr['cnt'] ?? cr['COUNT(Id)'] ?? '0'), 10);
            if (rid) storyCountMap.set(rid, cnt);
          }
        } catch { /* count failure is non-fatal */ }
      }

      this.post({
        type: 'releases',
        orgInstanceUrl: this.orgInstanceUrl,
        releases: records.map(r => ({
          id: r['Id'],
          name: r['Name'],
          status: r['copado__Status__c'] ?? '',
          storyCount: storyCountMap.get(r['Id']) ?? 0,
        })),
      });
    } catch (e) {
      this.post({ type: 'error', message: `Failed to fetch releases: ${String(e)}` });
    }
  }

  // ── Analyse two releases ────────────────────────────────────────────────────

  private async analyseReleases(promoteIds: string[], excludeIds: string[], excludeNames: string[]): Promise<void> {
    this.post({ type: 'status', message: `Fetching stories for ${promoteIds.length} release(s) to promote…` });
    try {
      const promoteStories = promoteIds.flatMap(id => this.fetchStoriesForRelease(id));
      const promoteMeta = this.fetchMetadataForStories(promoteStories.map(s => s.id));

      const allFutureStories: Story[] = [];
      const allFutureMeta: Array<{ name: string; type: string; storyId: string }> = [];

      for (let i = 0; i < excludeIds.length; i++) {
        const relName = excludeNames[i] ?? excludeIds[i];
        const stories = this.fetchStoriesForRelease(excludeIds[i]).map(s => ({ ...s, releaseName: relName }));
        allFutureStories.push(...stories);
        allFutureMeta.push(...this.fetchMetadataForStories(stories.map(s => s.id)));
      }

      this.post({ type: 'status', message: `Found ${promoteStories.length} stories across ${promoteIds.length} release(s) to promote, checking against ${allFutureStories.length} stories across ${excludeIds.length} future planned release(s). Fetching metadata…` });

      const common = this.findCommonComponents(promoteMeta, allFutureMeta, allFutureStories);
      this.post({ type: 'results', components: common, mode: 'release', orgInstanceUrl: this.orgInstanceUrl });
    } catch (e) {
      this.post({ type: 'error', message: String(e) });
    }
  }

  // ── Analyse two user stories directly ──────────────────────────────────────

  private async analyseStories(story1Name: string, story2Name: string): Promise<void> {
    this.post({ type: 'status', message: `Looking up stories ${story1Name} and ${story2Name}…` });
    try {
      const records = queryOrg(
        `SELECT Id, Name, copado__Base_Branch__c, copado__View_in_Git__c FROM copado__User_Story__c WHERE Name IN ('${story1Name}','${story2Name}')`,
        this.orgAlias
      );
      if (records.length < 2) {
        this.post({ type: 'error', message: `Could not find both stories. Found: ${records.map(r => r['Name']).join(', ') || 'none'}` });
        return;
      }
      const stories: Story[] = records.map(r => ({
        id: r['Id'],
        name: r['Name'],
        baseBranch: r['copado__Base_Branch__c'] ?? 'master',
        featureBranch: extractBranch(r['copado__View_in_Git__c'] ?? ''),
        branchUrl: extractBranchUrl(r['copado__View_in_Git__c'] ?? ''),
      }));

      this.post({ type: 'status', message: 'Fetching metadata for both stories…' });
      const meta1 = this.fetchMetadataForStories([stories[0].id]);
      const meta2 = this.fetchMetadataForStories([stories[1].id]);

      // For story mode, both stories are the "exclude" stories on common components
      const story1Map = new Map(meta1.map(m => [`${m.type}:${m.name}`, m]));
      const common: CommonComponent[] = [];

      for (const m of meta2) {
        const key = `${m.type}:${m.name}`;
        if (story1Map.has(key)) {
          // Component touched by both stories — show diff for each
          const s1 = stories.find(s => s.id === stories[0].id)!;
          const s2 = stories.find(s => s.id === stories[1].id)!;
          const existing = common.find(c => c.name === m.name && c.type === m.type);
          if (!existing) {
            common.push({ name: m.name, type: m.type, excludeStories: [s1, s2] });
          }
        }
      }

      this.post({ type: 'results', components: common, mode: 'story', orgInstanceUrl: this.orgInstanceUrl });
    } catch (e) {
      this.post({ type: 'error', message: String(e) });
    }
  }

  // ── Open VS Code diff editor ────────────────────────────────────────────────

  private async openDiff(
    storyName: string,
    baseBranch: string,
    featureBranch: string,
    componentName: string,
    componentType: string
  ): Promise<void> {
    const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';
    if (!repoPath) {
      void vscode.window.showErrorMessage('No workspace folder open. Please open the SF repo folder in VS Code.');
      return;
    }

    const filePath = getFilePath(componentName, componentType);
    this.post({ type: 'status', message: `Fetching branches from remote…` });

    // Fetch both branches so remote tracking refs are up to date
    gitFetchBranch(baseBranch, repoPath);
    gitFetchBranch(featureBranch, repoPath);

    // Check feature branch actually exists remotely — show a clear error if not
    if (!gitBranchExists(featureBranch, repoPath)) {
      this.post({ type: 'branchMissing', storyName, featureBranch });
      return;
    }

    // Use the merge base as the left side — this matches GitHub PR (three-dot diff):
    // shows only what THIS story changed, not lines other stories added to master after branching.
    const mergeBase = gitMergeBase(baseBranch, featureBranch, repoPath);
    log(`Merge base for ${baseBranch}..${featureBranch}: ${mergeBase}`);

    const baseContent    = gitFileContentAtRef(mergeBase, filePath, repoPath);
    const featureContent = gitFileContent(featureBranch, filePath, repoPath);

    if (!baseContent && !featureContent) {
      this.post({ type: 'error', message: `File "${filePath}" not found in either branch. The metadata path may differ.` });
      return;
    }

    // Store content in provider and open diff editor
    const baseUri = vscode.Uri.parse(`sfconflict:base/${storyName}/${encodeURIComponent(componentName)}`);
    const featUri = vscode.Uri.parse(`sfconflict:feature/${storyName}/${encodeURIComponent(componentName)}`);

    ReleaseCheckerPanel.gitProvider.set(baseUri.toString(), baseContent);
    ReleaseCheckerPanel.gitProvider.set(featUri.toString(), featureContent);

    // Title: merge-base sha (short) on left, feature branch on right — matches PR semantics
    const shortSha = mergeBase.slice(0, 7);
    const title = `${storyName} → ${componentName}  (merge-base ${shortSha} ↔ ${featureBranch})`;
    await vscode.commands.executeCommand('vscode.diff', baseUri, featUri, title);
    this.post({ type: 'status', message: `Diff opened: ${componentName}`, spinner: false });
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private fetchStoriesForRelease(releaseId: string): Story[] {
    const records = queryOrg(
      `SELECT Id, Name, copado__Base_Branch__c, copado__View_in_Git__c FROM copado__User_Story__c WHERE copado__Release__c = '${releaseId}'`,
      this.orgAlias
    );
    return records.map(r => ({
      id: r['Id'],
      name: r['Name'],
      baseBranch: r['copado__Base_Branch__c'] ?? 'master',
      featureBranch: extractBranch(r['copado__View_in_Git__c'] ?? ''),
      branchUrl: extractBranchUrl(r['copado__View_in_Git__c'] ?? ''),
    }));
  }

  private fetchMetadataForStories(storyIds: string[]): Array<{ name: string; type: string; storyId: string }> {
    if (storyIds.length === 0) return [];
    const all: Array<{ name: string; type: string; storyId: string }> = [];
    // Batch in groups of 50 to avoid query length limits
    for (let i = 0; i < storyIds.length; i += 50) {
      const batch = storyIds.slice(i, i + 50);
      const ids = batch.map(id => `'${id}'`).join(',');
      const records = queryOrg(
        `SELECT copado__Metadata_API_Name__c, copado__Type__c, copado__User_Story__c FROM copado__User_Story_Metadata__c WHERE copado__User_Story__c IN (${ids})`,
        this.orgAlias
      );
      for (const r of records) {
        all.push({
          name: r['copado__Metadata_API_Name__c'] ?? '',
          type: r['copado__Type__c'] ?? 'Unknown',
          storyId: r['copado__User_Story__c'] ?? '',
        });
      }
    }
    return all;
  }

  private findCommonComponents(
    promoteMeta: Array<{ name: string; type: string; storyId: string }>,
    excludeMeta: Array<{ name: string; type: string; storyId: string }>,
    excludeStories: Story[]
  ): CommonComponent[] {
    const promoteSet = new Set(promoteMeta.map(m => `${m.type}:${m.name}`));
    const storyById = new Map(excludeStories.map(s => [s.id, s]));
    const componentMap = new Map<string, CommonComponent>();

    for (const m of excludeMeta) {
      const key = `${m.type}:${m.name}`;
      if (!promoteSet.has(key)) continue;

      const story = storyById.get(m.storyId);
      if (!story) continue;

      if (!componentMap.has(key)) {
        componentMap.set(key, { name: m.name, type: m.type, excludeStories: [] });
      }
      const comp = componentMap.get(key)!;
      if (!comp.excludeStories.find(s => s.id === story.id)) {
        comp.excludeStories.push(story);
      }
    }

    return [...componentMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── HTML ────────────────────────────────────────────────────────────────────

  private getHtml(initialOrg = ''): string {
    const safeOrg = initialOrg.replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Release Conflict Checker</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}

  body{
    font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;
    font-size:14px;line-height:1.5;
    background:linear-gradient(145deg,#f0f2ff 0%,#fafbff 45%,#f5f0ff 100%) !important;
    color:#1e1b4b !important;
    padding:32px 36px 48px;
    min-height:100vh;
  }

  /* ── Glass card ── */
  .card{
    background:rgba(255,255,255,0.72);
    border:1px solid rgba(255,255,255,0.9);
    border-radius:18px;
    box-shadow:0 4px 24px rgba(99,102,241,.08),0 1px 4px rgba(0,0,0,.04);
    backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
    padding:22px 24px;
    margin-bottom:16px;
  }
  .card-title{
    font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.14em;color:#7c6fcd;margin-bottom:14px;
  }

  /* ── Header ── */
  .header{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid rgba(99,102,241,.15)}
  .header-title{
    font-size:26px;font-weight:900;letter-spacing:-.02em;
    background:linear-gradient(120deg,#4f46e5 0%,#7c3aed 50%,#a855f7 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  }
  .header-sub{font-size:12px;color:#8b8fa8;margin-top:4px}

  /* ── Inputs ── */
  .org-row{display:flex;gap:10px;align-items:center}
  .org-input,
  .field select,
  .field input{
    padding:10px 14px;
    border:1.5px solid rgba(99,102,241,.2);
    border-radius:12px;
    font-size:13px;
    font-family:Consolas,'Courier New',monospace;
    color:#1e1b4b;
    background:rgba(255,255,255,0.8);
    outline:none;
    transition:border-color .18s,box-shadow .18s,background .18s;
  }
  .org-input{flex:1}
  .field select,.field input{width:100%;font-family:'Segoe UI',system-ui,Arial,sans-serif}
  .org-input:focus,
  .field select:focus,
  .field input:focus{
    border-color:#6366f1;
    background:#fff;
    box-shadow:0 0 0 4px rgba(99,102,241,.14);
  }
  .org-input::placeholder,.field input::placeholder{color:#a8b0d0}
  .field{margin-bottom:14px}
  .field label{
    display:block;font-size:10px;font-weight:700;
    text-transform:uppercase;letter-spacing:.1em;color:#6b6f9a;margin-bottom:7px;
  }

  /* ── Dual listbox ── */
  .dual-listbox{display:flex;align-items:stretch;gap:8px;width:100%}
  .listbox-col{display:flex;flex-direction:column;flex:1;min-width:0}
  .listbox-col-label{font-size:10px;font-weight:600;color:#8b8fa8;letter-spacing:.05em;margin-bottom:4px}
  .listbox-col select{
    flex:1;width:100%;height:150px;
    border:1.5px solid rgba(99,102,241,.25);border-radius:10px;
    background:rgba(255,255,255,.7);color:#2d2f52;font-size:12px;padding:4px;
    outline:none;cursor:pointer;
  }
  .listbox-col select:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .listbox-col select option{padding:4px 8px;border-radius:6px}
  .listbox-col select option:checked{background:#e0e7ff;color:#3730a3}
  .listbox-arrows{display:flex;flex-direction:column;justify-content:center;gap:6px;flex:0 0 auto}
  .listbox-arrows button{
    display:flex;align-items:center;justify-content:center;
    width:32px;height:32px;border-radius:50%;border:none;
    background:linear-gradient(135deg,#6366f1,#818cf8);color:#fff;
    font-size:14px;cursor:pointer;transition:opacity .15s;
  }
  .listbox-arrows button:hover{opacity:.85}
  .listbox-arrows button:disabled{opacity:.35;cursor:default}

  /* ── Gradient pill buttons ── */
  .btn{
    padding:10px 24px;
    border:none;border-radius:50px;
    font-size:13px;font-weight:700;letter-spacing:.02em;
    cursor:pointer;transition:all .2s;white-space:nowrap;
  }
  .btn-primary{
    background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 60%,#a855f7 100%);
    color:#fff;
    box-shadow:0 4px 15px rgba(99,102,241,.4);
  }
  .btn-primary:hover{
    transform:translateY(-2px);
    box-shadow:0 8px 25px rgba(99,102,241,.5);
    filter:brightness(1.08);
  }
  .btn-primary:active{transform:translateY(0);box-shadow:0 2px 8px rgba(99,102,241,.3)}
  .btn-primary:disabled{
    background:linear-gradient(135deg,#c4c6f1,#ddd3f5);
    box-shadow:none;cursor:not-allowed;transform:none;filter:none;
  }
  .btn-sm{
    padding:5px 14px;font-size:11px;font-weight:700;
    border-radius:50px;border:none;cursor:pointer;transition:all .2s;
  }
  .btn-diff{
    background:linear-gradient(135deg,#0891b2,#06b6d4);
    color:#fff;
    box-shadow:0 4px 12px rgba(6,182,212,.35);
  }
  .btn-diff:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(6,182,212,.5);filter:brightness(1.08)}
  .btn-diff:active{transform:translateY(0)}

  /* ── Mode tabs ── */
  .tabs{
    display:flex;gap:4px;
    background:rgba(99,102,241,.07);
    border-radius:14px;padding:4px;margin-bottom:16px;
    border:1px solid rgba(99,102,241,.12);
  }
  .tab{
    flex:1;padding:9px 0;text-align:center;
    font-size:12px;font-weight:700;cursor:pointer;
    border-radius:11px;transition:all .2s;
    color:#8b8fa8;letter-spacing:.02em;
  }
  .tab.active{
    background:rgba(255,255,255,0.9);
    color:#5b4fff;
    box-shadow:0 2px 10px rgba(99,102,241,.18);
    border:1px solid rgba(99,102,241,.2);
  }

  /* ── Status bar ── */
  .status-bar{
    padding:12px 18px;border-radius:14px;font-size:12px;
    margin-bottom:14px;display:none;
    border:1px solid transparent;
    backdrop-filter:blur(10px);
  }
  .status-bar.show{display:flex;align-items:center;gap:10px}
  .status-info{background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.25);color:#3730a3}
  .status-error{background:rgba(239,68,68,.07);border-color:rgba(239,68,68,.25);color:#991b1b}
  .status-success{background:rgba(34,197,94,.07);border-color:rgba(34,197,94,.25);color:#166534}
  .spinner{
    width:14px;height:14px;flex-shrink:0;
    border:2px solid rgba(99,102,241,.2);
    border-top-color:#6366f1;
    border-radius:50%;animation:spin .7s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ── Results ── */
  .results-header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .results-title{font-size:14px;font-weight:700;color:#1e1b4b;flex:1}
  .results-badge{
    background:linear-gradient(135deg,#dc2626,#ef4444);
    color:#fff;border-radius:20px;padding:3px 12px;
    font-size:11px;font-weight:700;
    box-shadow:0 2px 8px rgba(220,38,38,.3);
  }
  .results-badge.zero{
    background:linear-gradient(135deg,#059669,#10b981);
    box-shadow:0 2px 8px rgba(5,150,105,.3);
  }
  .btn-reset{
    background:rgba(255,255,255,0.7);
    border:1px solid rgba(99,102,241,.2);
    color:#6b6f9a;
    border-radius:50px;padding:6px 16px;
    font-size:12px;font-weight:600;cursor:pointer;
    transition:all .2s;
  }
  .btn-reset:hover{border-color:rgba(239,68,68,.4);color:#dc2626;background:rgba(239,68,68,.06)}

  /* ── No-conflict ── */
  .no-common{text-align:center;padding:32px;color:#8b8fa8;font-size:13px}
  .no-common .big{font-size:36px;margin-bottom:10px}

  /* ── Component accordion ── */
  .component-list{display:flex;flex-direction:column;gap:8px}
  .component-item{
    border:1px solid rgba(99,102,241,.15);
    border-radius:14px;overflow:hidden;
    background:rgba(255,255,255,0.65);
    backdrop-filter:blur(10px);
    transition:border-color .2s,box-shadow .2s,background .2s;
  }
  .component-item:hover{
    border-color:rgba(99,102,241,.35);
    background:rgba(255,255,255,0.85);
    box-shadow:0 4px 20px rgba(99,102,241,.1);
  }
  .component-header{
    display:flex;align-items:center;gap:10px;
    padding:12px 16px;cursor:pointer;
    transition:background .15s;user-select:none;
  }
  .component-header:hover{background:rgba(99,102,241,.04)}
  .component-chevron{
    font-size:10px;color:#a8b0d0;
    transition:transform .22s;width:12px;text-align:center;
  }
  .component-chevron.open{transform:rotate(90deg)}
  .component-name{
    font-family:Consolas,'Courier New',monospace;
    font-size:13px;font-weight:700;color:#1e1b4b;flex:1;
  }
  .component-type{
    font-size:10px;font-weight:700;padding:3px 10px;
    border-radius:20px;
    background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(168,85,247,.1));
    color:#5b21b6;letter-spacing:.04em;
    border:1px solid rgba(99,102,241,.2);
  }
  .component-count{font-size:11px;color:#a8b0d0}
  .component-stories{display:none;border-top:1px solid rgba(99,102,241,.1);background:rgba(245,243,255,0.5)}
  .component-stories.open{display:block}
  .story-row{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 16px 10px 32px;
    border-bottom:1px solid rgba(99,102,241,.07);
  }
  .story-row:last-child{border-bottom:none}
  .story-info{display:flex;flex-direction:column;gap:3px}
  .story-release-tag{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.4px;padding:1px 7px;border-radius:10px;background:rgba(99,102,241,.12);color:#4338ca;margin-bottom:2px;max-width:fit-content}
  .story-name{font-family:Consolas,'Courier New',monospace;font-size:12px;font-weight:700;color:#4338ca}
  .story-name a{
    color:inherit;text-decoration:none;cursor:pointer;
    border-bottom:1px dashed rgba(67,56,202,.4);
    transition:border-color .15s;
  }
  .story-name a:hover{border-bottom-color:#4338ca}
  .story-branch{font-size:11px;color:#8b8fa8;font-family:Consolas,'Courier New',monospace}
  .story-branch a{
    color:#0891b2;text-decoration:none;cursor:pointer;
    border-bottom:1px dashed rgba(8,145,178,.35);
    transition:border-color .15s;
  }
  .story-branch a:hover{border-bottom-color:#0891b2}
  .story-no-branch{font-size:11px;color:#d97706;font-style:italic}

  /* ── Stat chips ── */
  .stat-row{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .stat-chip{
    background:rgba(255,255,255,0.7);
    border:1px solid rgba(99,102,241,.15);
    border-radius:20px;padding:5px 16px;
    font-size:12px;color:#6b6f9a;
    backdrop-filter:blur(8px);
  }
  .stat-chip b{color:#4f46e5;font-weight:800}

  /* ── Legend ── */
  .legend{font-size:11px;color:#a8b0d0;padding:10px 0 0;border-top:1px solid rgba(99,102,241,.1);margin-top:10px}
  .legend span{margin-right:16px}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-title">SF Release Conflict Checker</div>
  <div class="header-sub">Identify common metadata between releases or stories and inspect Git differences</div>
</div>

<!-- Org Connection -->
<div class="card">
  <div class="card-title">Salesforce Org Connection</div>
  <div class="org-row">
    <input id="orgAlias" class="org-input" type="text" value="${safeOrg}" placeholder="Enter org alias  (e.g. RBKINT-CPQAI)" autocomplete="off"/>
    <button class="btn btn-primary" onclick="connectOrg()">Connect &amp; Load Releases</button>
  </div>
</div>

<!-- Mode Selector -->
<div class="card" id="modeCard" style="display:none">
  <div class="card-title">Analysis Mode</div>
  <div class="tabs">
    <div class="tab active" id="tabRelease" onclick="switchMode('release')">By Release</div>
    <div class="tab" id="tabStory" onclick="switchMode('story')">By User Story</div>
  </div>

  <!-- Release Mode -->
  <div id="releaseMode">
    <div class="field">
      <label>Releases to Promote</label>
      <div class="dual-listbox">
        <div class="listbox-col">
          <div class="listbox-col-label">Available</div>
          <select id="promoteAvailable" multiple ondblclick="moveReleases('promote', true)"></select>
        </div>
        <div class="listbox-arrows">
          <button title="Add selected" onclick="moveReleases('promote', true)">▶</button>
          <button title="Remove selected" onclick="moveReleases('promote', false)">◀</button>
        </div>
        <div class="listbox-col">
          <div class="listbox-col-label">Releases to Promote</div>
          <select id="promoteSelected" multiple ondblclick="moveReleases('promote', false)"></select>
        </div>
      </div>
    </div>
    <div class="field">
      <label>Future Planned Releases</label>
      <div class="dual-listbox">
        <div class="listbox-col">
          <div class="listbox-col-label">Available</div>
          <select id="futureAvailable" multiple ondblclick="moveReleases('future', true)"></select>
        </div>
        <div class="listbox-arrows">
          <button title="Add selected" onclick="moveReleases('future', true)">▶</button>
          <button title="Remove selected" onclick="moveReleases('future', false)">◀</button>
        </div>
        <div class="listbox-col">
          <div class="listbox-col-label">Future Planned Releases</div>
          <select id="futureSelected" multiple ondblclick="moveReleases('future', false)"></select>
        </div>
      </div>
    </div>
    <button class="btn btn-primary" onclick="analyseReleases()" id="btnAnalyseReleases">Analyse Common Components</button>
  </div>

  <!-- Story Mode -->
  <div id="storyMode" style="display:none">
    <div class="field">
      <label>User Story 1</label>
      <input id="story1Input" class="org-input" style="font-family:Consolas,monospace" type="text" placeholder="e.g. US-0030781" autocomplete="off"/>
    </div>
    <div class="field">
      <label>User Story 2</label>
      <input id="story2Input" class="org-input" style="font-family:Consolas,monospace" type="text" placeholder="e.g. US-0029093" autocomplete="off"/>
    </div>
    <button class="btn btn-primary" onclick="analyseStories()" id="btnAnalyseStories">Compare Stories</button>
  </div>
</div>

<!-- Status Bar -->
<div class="status-bar status-info" id="statusBar">
  <div class="spinner" id="statusSpinner"></div>
  <span id="statusText"></span>
</div>

<!-- Results -->
<div id="resultsSection" style="display:none">
  <div class="card">
    <div class="stat-row" id="statRow"></div>
    <div class="results-header">
      <div class="results-title">Common Components</div>
      <div class="results-badge" id="commonBadge">0</div>
      <button class="btn-reset" onclick="resetAll()">↺ Reset</button>
    </div>
    <div id="componentList" class="component-list"></div>
    <div class="legend">
      <span>Left = base branch at merge point &nbsp;|&nbsp; Right = feature branch</span>
      <span>View Diff opens VS Code diff editor</span>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let currentMode = 'release';

  function connectOrg() {
    const alias = document.getElementById('orgAlias').value.trim();
    if (!alias) { showStatus('Please enter an org alias.', 'error'); return; }
    showStatus('Connecting to org and loading releases…', 'info', true);
    vscode.postMessage({ command: 'fetchReleases', orgAlias: alias });
  }

  function switchMode(mode) {
    currentMode = mode;
    document.getElementById('tabRelease').classList.toggle('active', mode === 'release');
    document.getElementById('tabStory').classList.toggle('active', mode === 'story');
    document.getElementById('releaseMode').style.display = mode === 'release' ? 'block' : 'none';
    document.getElementById('storyMode').style.display = mode === 'story' ? 'block' : 'none';
    document.getElementById('resultsSection').style.display = 'none';
    clearStatus();
  }

  // A release can sit in only one of the two selected lists, so both pickers render from shared state.
  let _releases = [];
  const _picked = { promote: [], future: [] };

  function releaseLabel(r) {
    let label = r.name;
    if (r.status) label += ' [' + r.status + ']';
    if (r.storyCount > 0) label += ' — ' + r.storyCount + ' stor' + (r.storyCount === 1 ? 'y' : 'ies');
    return label;
  }

  function fillSelect(id, list) {
    document.getElementById(id).innerHTML = list.map(r => '<option value="' + esc(r.id) + '">' + esc(releaseLabel(r)) + '</option>').join('');
  }

  function renderReleasePickers() {
    const taken = new Set([..._picked.promote, ..._picked.future]);
    const free = _releases.filter(r => !taken.has(r.id));
    const byId = id => _releases.find(r => r.id === id);
    fillSelect('promoteAvailable', free);
    fillSelect('futureAvailable', free);
    fillSelect('promoteSelected', _picked.promote.map(byId));
    fillSelect('futureSelected', _picked.future.map(byId));
  }

  function moveReleases(list, add) {
    const from = document.getElementById(list + (add ? 'Available' : 'Selected'));
    const ids = Array.from(from.selectedOptions).map(o => o.value);
    if (!ids.length) return;
    _picked[list] = add ? [..._picked[list], ...ids] : _picked[list].filter(id => !ids.includes(id));
    renderReleasePickers();
  }

  function analyseReleases() {
    const promoteIds = [..._picked.promote];
    const excludeIds = [..._picked.future];
    const nameOf = id => (_releases.find(r => r.id === id) || {}).name || id;
    if (promoteIds.length === 0) { showStatus('Please add at least one Release to Promote.', 'error'); return; }
    if (excludeIds.length === 0) { showStatus('Please add at least one Future Planned Release.', 'error'); return; }
    showStatus('Fetching stories and metadata for ' + promoteIds.length + ' release(s) to promote and ' + excludeIds.length + ' future planned release(s)…', 'info', true);
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('btnAnalyseReleases').disabled = true;
    vscode.postMessage({ command: 'analyseReleases', promoteIds, excludeIds, excludeNames: excludeIds.map(nameOf) });
  }

  function analyseStories() {
    const story1 = document.getElementById('story1Input').value.trim().toUpperCase();
    const story2 = document.getElementById('story2Input').value.trim().toUpperCase();
    if (!story1 || !story2) { showStatus('Please enter both story names.', 'error'); return; }
    if (story1 === story2) { showStatus('Please enter two different story names.', 'error'); return; }
    showStatus('Looking up stories and fetching metadata…', 'info', true);
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('btnAnalyseStories').disabled = true;
    vscode.postMessage({ command: 'analyseStories', story1, story2 });
  }

  function toggleComponent(id) {
    const stories = document.getElementById('stories-' + id);
    const chevron = document.getElementById('chevron-' + id);
    const isOpen = stories.classList.contains('open');
    stories.classList.toggle('open', !isOpen);
    chevron.classList.toggle('open', !isOpen);
  }

  let _orgInstanceUrl = '';

  function resetAll() {
    // Clear results
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('componentList').innerHTML = '';
    // Clear status
    clearStatus();
    // Clear both release pickers
    _releases = [];
    _picked.promote = [];
    _picked.future = [];
    renderReleasePickers();
    // Clear story inputs
    document.getElementById('story1Input').value = '';
    document.getElementById('story2Input').value = '';
    // Re-enable buttons
    document.getElementById('btnAnalyseReleases').disabled = false;
    document.getElementById('btnAnalyseStories').disabled = false;
    // Hide mode card so user reconnects fresh
    document.getElementById('modeCard').style.display = 'none';
    _orgInstanceUrl = '';
  }

  function openUrl(url) {
    vscode.postMessage({ command: 'openUrl', url });
  }

  function viewDiff(storyName, baseBranch, featureBranch, componentName, componentType) {
    showStatus('Checking branch and opening diff for ' + componentName + ' (' + storyName + ')…', 'info', true);
    scrollToStatus(); // scroll immediately so user sees the spinner right away
    vscode.postMessage({ command: 'viewDiff', storyName, baseBranch, featureBranch, componentName, componentType });
  }

  function scrollToStatus() {
    document.getElementById('statusBar').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showStatus(message, type, spinner) {
    const bar = document.getElementById('statusBar');
    const text = document.getElementById('statusText');
    const spin = document.getElementById('statusSpinner');
    bar.className = 'status-bar show status-' + (type || 'info');
    text.textContent = message;
    spin.style.display = spinner ? 'block' : 'none';
  }

  function clearStatus() {
    document.getElementById('statusBar').classList.remove('show');
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function storyNameHtml(s) {
    const storyUrl = _orgInstanceUrl ? _orgInstanceUrl + '/lightning/r/copado__User_Story__c/' + esc(s.id) + '/view' : '';
    if (storyUrl) {
      return '<a href="#" onclick="openUrl(\\\'' + storyUrl + '\\\');return false;">' + esc(s.name) + '</a>';
    }
    return esc(s.name);
  }

  function branchHtml(s) {
    if (!s.featureBranch) return '<div class="story-no-branch">⚠ No feature branch found</div>';
    if (s.branchUrl) {
      return '<div class="story-branch">Base: ' + esc(s.baseBranch) + ' &nbsp;→&nbsp; ' +
        '<a href="#" onclick="openUrl(\\\'' + s.branchUrl + '\\\');return false;">' + esc(s.featureBranch) + '</a></div>';
    }
    return '<div class="story-branch">Base: ' + esc(s.baseBranch) + ' &nbsp;→&nbsp; Feature: ' + esc(s.featureBranch) + '</div>';
  }

  function renderResults(components, mode) {
    const section = document.getElementById('resultsSection');
    const badge = document.getElementById('commonBadge');
    const list = document.getElementById('componentList');
    const statRow = document.getElementById('statRow');

    badge.textContent = components.length;
    badge.className = 'results-badge' + (components.length === 0 ? ' zero' : '');
    section.style.display = 'block';

    const totalStories = new Set(components.flatMap(c => c.excludeStories.map(s => s.name))).size;
    const futureReleaseNames = [...new Set(components.flatMap(c => c.excludeStories.map(s => s.releaseName).filter(Boolean)))];
    statRow.innerHTML =
      '<div class="stat-chip"><b>' + components.length + '</b> common components</div>' +
      (mode === 'release' && futureReleaseNames.length > 0
        ? '<div class="stat-chip"><b>' + futureReleaseNames.length + '</b> future planned release' + (futureReleaseNames.length === 1 ? '' : 's') + ' with conflicts</div>'
        : '') +
      '<div class="stat-chip"><b>' + totalStories + '</b> ' + (mode === 'story' ? 'stories involved' : 'future-release stories involved') + '</div>';

    if (components.length === 0) {
      list.innerHTML = '<div class="no-common"><div class="big">✅</div><b>No common components found.</b><br/>Both releases/stories touch completely separate metadata.</div>';
      return;
    }

    list.innerHTML = components.map((comp, idx) => {
      const storyRows = comp.excludeStories.map(s => {
        const hasBranch = !!(s.featureBranch && s.featureBranch.length > 0);
        return '<div class="story-row" id="story-row-' + esc(s.name) + '-' + idx + '">' +
          '<div class="story-info">' +
            (s.releaseName ? '<div class="story-release-tag">' + esc(s.releaseName) + '</div>' : '') +
            '<div class="story-name">' + storyNameHtml(s) + '</div>' +
            branchHtml(s) +
          '</div>' +
          (hasBranch
            ? '<button class="btn btn-sm btn-diff" onclick=\\'viewDiff(' +
                JSON.stringify(s.name) + ',' +
                JSON.stringify(s.baseBranch) + ',' +
                JSON.stringify(s.featureBranch) + ',' +
                JSON.stringify(comp.name) + ',' +
                JSON.stringify(comp.type) +
              ')\\'>View Diff</button>'
            : '<span style="font-size:10px;color:#c06020">No branch</span>'
          ) +
        '</div>';
      }).join('');

      return '<div class="component-item">' +
        '<div class="component-header" onclick="toggleComponent(' + idx + ')">' +
          '<span class="component-chevron" id="chevron-' + idx + '">▶</span>' +
          '<span class="component-name">' + esc(comp.name) + '</span>' +
          '<span class="component-type">' + esc(comp.type) + '</span>' +
          '<span class="component-count">' + comp.excludeStories.length + ' stor' + (comp.excludeStories.length === 1 ? 'y' : 'ies') + '</span>' +
        '</div>' +
        '<div class="component-stories" id="stories-' + idx + '">' +
          storyRows +
        '</div>' +
      '</div>';
    }).join('');
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'releases': {
        _orgInstanceUrl = msg.orgInstanceUrl || '';
        document.getElementById('modeCard').style.display = 'block';
        _releases = msg.releases;
        _picked.promote = [];
        _picked.future = [];
        renderReleasePickers();
        showStatus('Loaded ' + msg.releases.length + ' releases. Select releases and click Analyse.', 'success', false);
        break;
      }
      case 'results':
        _orgInstanceUrl = msg.orgInstanceUrl || _orgInstanceUrl;
        document.getElementById('btnAnalyseReleases').disabled = false;
        document.getElementById('btnAnalyseStories').disabled = false;
        renderResults(msg.components, msg.mode);
        if (msg.components.length === 0) {
          showStatus('Analysis complete — no common components found.', 'success', false);
        } else {
          showStatus('Analysis complete — ' + msg.components.length + ' common components found. Expand each to view story diffs.', 'success', false);
        }
        break;
      case 'status':
        showStatus(msg.message, 'info', msg.spinner !== false);
        if (msg.spinner === false) scrollToStatus(); // diff opened — scroll to show confirmation
        break;
      case 'branchMissing':
        showStatus(
          '⚠ Branch "' + msg.featureBranch + '" not found in GitHub — likely deleted after merging. No diff available for ' + msg.storyName + '.',
          'error', false
        );
        scrollToStatus();
        break;
      case 'error':
        document.getElementById('btnAnalyseReleases').disabled = false;
        document.getElementById('btnAnalyseStories').disabled = false;
        showStatus('Error: ' + msg.message, 'error', false);
        scrollToStatus();
        break;
    }
  });

  // Allow Enter key to connect
  document.getElementById('orgAlias').addEventListener('keydown', e => {
    if (e.key === 'Enter') connectOrg();
  });
  document.getElementById('story1Input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('story2Input').focus();
  });
  document.getElementById('story2Input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') analyseStories();
  });
</script>
</body>
</html>`;
  }

  public dispose(): void {
    ReleaseCheckerPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
