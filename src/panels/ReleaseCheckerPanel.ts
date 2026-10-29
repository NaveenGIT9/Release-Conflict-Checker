import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitContentProvider } from '../extension';

// ─── Debug log ────────────────────────────────────────────────────────────────

let _out: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!_out) _out = vscode.window.createOutputChannel('SF Release Checker');
  _out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SfRecord { [key: string]: string }

interface SavedPrefs {
  prSource?: 'feature' | 'promo';
  mode?: 'release' | 'story';
  theme?: 'auto' | 'light' | 'dark';
  promoEnv?: string;         // '' = the story's next environment
}

interface PromoEnvResult {
  prs: PullRequest[];
  promotions: string[];      // qualified promotion names
  note?: string;             // why no PRs are shown
}

interface PullRequest {
  number: number;
  state: string;
  merged: boolean;
  targetBranch: string;
  url: string;
  promotion?: string;    // promotion name (e.g. P06132) when the PR was raised from a promotion branch
}

interface Story {
  id: string;
  name: string;
  baseBranch: string;
  baseBranchMissing: boolean;
  featureBranch: string; // e.g. "feature/US-0030781"
  branchUrl: string;     // full GitHub URL for the feature branch (may be empty)
  repoUrl: string;       // GitHub repo the story lives in, e.g. https://github.com/Rubrik-IT-Apps/Copado-Training
  releaseName?: string;  // which future planned release this story belongs to
  prs?: PullRequest[];
  prLookupFailed?: boolean;
  promoEnvs?: Record<string, PromoEnvResult>; // keyed by destination environment name, in first-promotion order
  promoNote?: string;        // set when the story has no forward promotion at all
  promoLookupFailed?: boolean;
  nextEnv?: string;
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

// "https://github.com/Owner/Repo/tree/x" or ".../pull/23" → "https://github.com/Owner/Repo"
function repoUrlFrom(url: string): string {
  const m = (url || '').match(/^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s#?]+)/i);
  return m ? m[1].replace(/\.git$/i, '') : '';
}

function normaliseRepoUrl(url: string): string {
  return url.trim().toLowerCase().replace(/^(https?:\/\/)[^@/]+@/, '$1').replace(/\.git$/, '').replace(/\/+$/, '');
}

// PRs raised before the repo move live in the old repo; their refs don't exist in the story's current one.
function splitByRepo(storyRepo: string, prs: PullRequest[]): { prs: PullRequest[]; notes: string[] } {
  const otherRepo = (p: PullRequest): string => {
    const prRepo = repoUrlFrom(p.url);
    return storyRepo && prRepo && normaliseRepoUrl(prRepo) !== normaliseRepoUrl(storyRepo) ? prRepo : '';
  };
  return {
    prs: prs.filter(p => !otherRepo(p)),
    notes: prs.filter(otherRepo).map(p => `#${p.number} is in ${otherRepo(p).split('/').pop()} (old repo)`),
  };
}

// Reads a possibly nested field (e.g. "copado__Promotion__r.Name") from an sf query record.
function val(r: SfRecord, fieldPath: string): string {
  let cur: unknown = r;
  for (const k of fieldPath.split('.')) cur = (cur as Record<string, unknown> | null | undefined)?.[k];
  return cur === null || cur === undefined ? '' : String(cur);
}

const isTemplate = (name: string, apiName: string, want: 'promote' | 'deploy'): boolean =>
  name.toLowerCase().replace(/[^a-z]/g, '') === `sfdx${want}` || new RegExp(`^sfdx_${want}(_\\d+)?$`, 'i').test(apiName);

function toStory(r: SfRecord): Story {
  const base = (r['copado__Base_Branch__c'] ?? '').trim();
  return {
    id: r['Id'],
    name: r['Name'],
    baseBranch: base || 'master',
    baseBranchMissing: !base,
    featureBranch: extractBranch(r['copado__View_in_Git__c'] ?? ''),
    branchUrl: extractBranchUrl(r['copado__View_in_Git__c'] ?? ''),
    repoUrl: repoUrlFrom(extractBranchUrl(r['copado__View_in_Git__c'] ?? '')),
  };
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

function git(args: string[], repoPath: string, opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd: repoPath, encoding: 'utf8', shell: false, input: opts.input, env: opts.env, maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

function gitRefExists(ref: string, repoPath: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath).ok;
}

function gitFetchRefspecs(refspecs: string[], repoPath: string): void {
  if (refspecs.length === 0) return;
  if (git(['fetch', 'origin', ...refspecs], repoPath).ok) return;
  // One missing ref fails the whole batch — retry individually so the rest still land.
  for (const spec of refspecs) git(['fetch', 'origin', spec], repoPath);
}

// The story's own commits in a PR: reachable from the PR head, minus the story's base branch,
// minus whatever the target branch already had when the PR was merged (or has now, if still open).
function prStoryCommits(pr: PullRequest, baseBranch: string, repoPath: string): { commits: string[] } | { error: string } {
  const head = git(['rev-parse', '--verify', '--quiet', `refs/remotes/pr/${pr.number}^{commit}`], repoPath).out.trim();
  if (!head) return { error: 'PR head could not be fetched from GitHub' };

  const exclude: string[] = [];
  const baseRef = `origin/${baseBranch}`;
  if (gitRefExists(baseRef, repoPath)) exclude.push(`^${baseRef}`);

  const targetRef = pr.targetBranch ? `origin/${pr.targetBranch}` : '';
  if (targetRef && gitRefExists(targetRef, repoPath)) {
    const inTarget = git(['merge-base', '--is-ancestor', head, targetRef], repoPath).ok;
    if (inTarget) {
      // Copado lands PRs through promotion-branch merges, so find the oldest merge that brought the head in.
      const merges = git(['log', targetRef, '--ancestry-path', '--merges', '--format=%H', `${head}..${targetRef}`], repoPath)
        .out.trim().split('\n').filter(Boolean);
      const landing = merges[merges.length - 1];
      if (landing) exclude.push(`^${landing}^1`);
    } else {
      exclude.push(`^${targetRef}`);
    }
  }

  const r = git(['rev-list', '--no-merges', head, ...exclude], repoPath);
  if (!r.ok) return { error: 'could not list PR commits' };
  log(`PR #${pr.number} head ${head.slice(0, 10)} excl [${exclude.join(' ')}] → ${r.out.trim().split('\n').filter(Boolean).length} commit(s)`);
  return { commits: r.out.trim().split('\n').filter(Boolean) };
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// In a promotion PR, the story arrives through Copado's "Merging feature/<story> to promotion/<P>" commit;
// only that merge counts, so other stories in the same promotion stay out of the diff.
function promoStoryCommits(pr: PullRequest, storyName: string, baseBranch: string, repoPath: string):
  { commits: string[]; note?: string } | { error: string } {
  const head = git(['rev-parse', '--verify', '--quiet', `refs/remotes/pr/${pr.number}^{commit}`], repoPath).out.trim();
  if (!head) return { error: 'PR head could not be fetched from GitHub' };
  const promo = pr.promotion ?? '';
  const pattern = `Merging feature/${reEscape(storyName)} to promotion/${reEscape(promo)}([^0-9A-Za-z]|$)`;
  const found = git(['log', head, '-i', '-E', `--grep=${pattern}`, '--format=%H %P'], repoPath)
    .out.trim().split('\n').filter(Boolean).map(l => l.split(' '));
  const merges = found.filter(parts => parts.length > 2).map(parts => parts[0]);
  if (merges.length) {
    log(`PR #${pr.number} (${promo}) merge commit(s) for ${storyName}: ${merges.map(m => m.slice(0, 10)).join(', ')}`);
    return { commits: merges };
  }

  // No true merge (fast-forward or a different message): fall back to the story's own commits in the PR.
  const res = prStoryCommits(pr, baseBranch, repoPath);
  if ('error' in res) return res;
  const nameRe = new RegExp(`^(${reEscape(storyName)}\\b|Merging feature/${reEscape(storyName)}\\b)`, 'i');
  const commits = git(['log', '--no-walk', '--stdin', '--format=%H %s'], repoPath, { input: res.commits.join('\n') + '\n' })
    .out.trim().split('\n').filter(Boolean)
    .filter(l => nameRe.test(l.slice(l.indexOf(' ') + 1)))
    .map(l => l.split(' ')[0]);
  if (commits.length === 0) return { error: `no merge of ${storyName} into promotion/${promo} found in the PR` };
  return { commits, note: `#${pr.number}: no merge commit for ${storyName} found, used commits named after the story` };
}

function byCommitTime(lines: string): string[] {
  return lines.trim().split('\n').filter(Boolean)
    .map(l => { const [t, h] = l.split(' '); return { t: Number(t), h }; })
    .sort((a, b) => a.t - b.t)
    .map(x => x.h);
}

// Replays only the given commits' changes to one file, so base-branch changes merged in between stay out.
function storyOnlyFileDiff(commits: string[], filePath: string, repoPath: string):
  { left: string; right: string; touching: string[]; exact: boolean } | null {
  const touching = byCommitTime(git(['log', '--no-walk', '--stdin', '--format=%ct %H', '--', filePath], repoPath, { input: commits.join('\n') + '\n' }).out);
  return touching.length ? replayFileDiff(touching, filePath, repoPath) : null;
}

// Merge commits are compared with their first parent: what the merge brought into the promotion branch.
// git log's path filter would drop a merge that matches its feature-side parent, so check each commit directly.
function mergeCommitsFileDiff(commits: string[], filePath: string, repoPath: string):
  { left: string; right: string; touching: string[]; exact: boolean } | null {
  const ordered = byCommitTime(git(['log', '--no-walk', '--stdin', '--format=%ct %H'], repoPath, { input: commits.join('\n') + '\n' }).out);
  const touching = ordered.filter(c => !git(['diff', '--quiet', `${c}^1`, c, '--', filePath], repoPath).ok);
  return touching.length ? replayFileDiff(touching, filePath, repoPath) : null;
}

function replayFileDiff(touching: string[], filePath: string, repoPath: string):
  { left: string; right: string; touching: string[]; exact: boolean } {
  const first = touching[0];
  const left = gitFileContentAtRef(`${first}^`, filePath, repoPath);
  const indexFile = path.join(os.tmpdir(), `sfconflict-${process.pid}-${Date.now()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  let exact = true;
  let right = '';
  try {
    git(['read-tree', '--empty'], repoPath, { env });
    const blob = git(['rev-parse', '--verify', '--quiet', `${first}^:${filePath}`], repoPath).out.trim();
    if (blob) git(['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`], repoPath, { env });

    for (const c of touching) {
      const patch = git(['diff', '--binary', `${c}^`, c, '--', filePath], repoPath).out;
      if (!patch) continue;
      if (git(['apply', '--cached'], repoPath, { input: patch, env }).ok) continue;
      if (git(['apply', '--cached', '--3way'], repoPath, { input: patch, env }).ok) continue;
      log(`Patch from ${c.slice(0, 10)} did not apply cleanly to ${filePath}; falling back to file at newest commit`);
      exact = false;
      break;
    }
    right = exact
      ? git(['show', `:${filePath}`], repoPath, { env }).out
      : gitFileContentAtRef(touching[touching.length - 1], filePath, repoPath);
  } finally {
    try { fs.unlinkSync(indexFile); } catch { /* never created */ }
  }
  return { left, right, touching, exact };
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
    const prefs = ReleaseCheckerPanel.context?.globalState.get<SavedPrefs>('savedPrefs') ?? {};
    this.panel.webview.html = this.getHtml(detected, prefs);
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
          (msg.repoUrl as string) ?? '',
          msg.baseBranch as string,
          extractBranch(msg.featureBranch as string), // re-sanitise in case webview cached dirty value
          msg.componentName as string,
          msg.componentType as string
        );
        break;
      case 'viewPrDiff':
        await this.openPrDiff(
          msg.storyName as string,
          (msg.repoUrl as string) ?? '',
          msg.baseBranch as string,
          Boolean(msg.baseBranchMissing),
          (msg.prs as PullRequest[]) ?? [],
          typeof msg.prNumber === 'number' ? msg.prNumber : null,
          msg.componentName as string,
          msg.componentType as string,
          msg.source === 'promo' ? 'promo' : 'feature'
        );
        break;
      case 'openUrl':
        void vscode.env.openExternal(vscode.Uri.parse(msg.url as string));
        break;
      case 'savePrefs': {
        const p = (msg.prefs ?? {}) as SavedPrefs;
        const prefs: SavedPrefs = {
          prSource: p.prSource === 'promo' ? 'promo' : 'feature',
          mode: p.mode === 'story' ? 'story' : 'release',
          theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'auto',
          promoEnv: typeof p.promoEnv === 'string' ? p.promoEnv.slice(0, 120) : '',
        };
        await ReleaseCheckerPanel.context?.globalState.update('savedPrefs', prefs);
        this.post({ type: 'prefsSaved', prefs });
        break;
      }
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
      const involved = common.flatMap(c => c.excludeStories);
      if (involved.length > 0) {
        this.post({ type: 'status', message: `Fetching pull requests for ${new Set(involved.map(s => s.id)).size} future-release stories…` });
        this.attachPullRequests(involved);
        this.post({ type: 'status', message: 'Checking promotions and promotion pull requests…' });
        this.attachPromotionPullRequests(involved);
      }
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
      const stories: Story[] = records.map(toStory);

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

      if (common.length > 0) {
        this.post({ type: 'status', message: 'Fetching pull requests for both stories…' });
        this.attachPullRequests(stories);
        this.post({ type: 'status', message: 'Checking promotions and promotion pull requests…' });
        this.attachPromotionPullRequests(stories);
      }
      this.post({ type: 'results', components: common, mode: 'story', orgInstanceUrl: this.orgInstanceUrl });
    } catch (e) {
      this.post({ type: 'error', message: String(e) });
    }
  }

  // ── Open VS Code diff editor ────────────────────────────────────────────────

  private async openDiff(
    storyName: string,
    repoUrl: string,
    baseBranch: string,
    featureBranch: string,
    componentName: string,
    componentType: string
  ): Promise<void> {
    let repoPath: string;
    try {
      repoPath = await this.resolveRepoPath(repoUrl);
    } catch (e) {
      this.post({ type: 'notice', level: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    log(`Branch diff for ${storyName} using repo ${repoPath}`);

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
    await this.showDiff(baseUri, featUri, title);
    this.post({ type: 'status', message: `Diff opened: ${componentName}`, spinner: false });
  }

  // Opens as a tab in the checker's own editor group so the diff gets the full window width.
  private async showDiff(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
    const column = this.panel.viewColumn ?? vscode.ViewColumn.Active;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { viewColumn: column, preview: false });
  }

  // ── Diff built from the story's own PR commits ──────────────────────────────

  // The story's own repo: an open workspace folder if it is that repo, otherwise a clone kept in extension storage.
  private async resolveRepoPath(repoUrl: string): Promise<string> {
    const wanted = normaliseRepoUrl(repoUrl);
    if (!wanted) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';
      if (!ws) throw new Error('Story has no GitHub link in Copado and no workspace folder is open.');
      return ws;
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const origin = git(['remote', 'get-url', 'origin'], f.uri.fsPath).out.trim();
      if (origin && normaliseRepoUrl(origin) === wanted) return f.uri.fsPath;
    }

    const storage = ReleaseCheckerPanel.context?.globalStorageUri.fsPath ?? path.join(os.tmpdir(), 'sf-release-checker');
    const dir = path.join(storage, 'repos', wanted.replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]+/g, '__'));
    if (fs.existsSync(path.join(dir, '.git'))) return dir;

    fs.mkdirSync(path.dirname(dir), { recursive: true });
    this.post({ type: 'status', message: `Cloning ${repoUrl} (first time only — later runs just fetch)…` });
    log(`Cloning ${repoUrl} into ${dir}`);
    // Async so a large first clone doesn't freeze VS Code; blobless keeps it small.
    const code = await new Promise<number>(resolve => {
      const p = spawn('git', ['clone', '--filter=blob:none', '--no-checkout', `${repoUrl}.git`, dir], { shell: false });
      let err = '';
      p.stderr.on('data', d => { err += String(d); });
      p.on('close', c => { if (c !== 0) log(`clone failed: ${err.slice(-800)}`); resolve(c ?? 1); });
      p.on('error', e => { log(`clone failed: ${e.message}`); resolve(1); });
    });
    if (code !== 0) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* partial clone */ }
      throw new Error(`Could not clone ${repoUrl}. Check you have access to it in GitHub (see "SF Release Checker" output for details).`);
    }
    return dir;
  }

  private async openPrDiff(
    storyName: string,
    repoUrl: string,
    baseBranch: string,
    baseBranchMissing: boolean,
    allPrs: PullRequest[],
    onlyPr: number | null,
    componentName: string,
    componentType: string,
    source: 'feature' | 'promo' = 'feature'
  ): Promise<void> {
    const storyRepo = repoUrl || repoUrlFrom(allPrs.find(p => p.url)?.url ?? '');
    const requested = onlyPr === null ? allPrs : allPrs.filter(p => p.number === onlyPr);
    if (requested.length === 0) {
      this.post({ type: 'notice', level: 'error', message: `No PR raised for ${storyName} — nothing to diff.` });
      return;
    }
    const { prs, notes: oldRepoNotes } = splitByRepo(storyRepo, requested);
    if (prs.length === 0) {
      this.post({ type: 'notice', level: 'warn', message: `${oldRepoNotes.join('; ')}.` });
      return;
    }

    let repoPath: string;
    try {
      repoPath = await this.resolveRepoPath(storyRepo);
    } catch (e) {
      this.post({ type: 'notice', level: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    log(`PR diff for ${storyName} using repo ${repoPath}`);
    const prLabel = prs.map(p => `#${p.number}${p.promotion ? ` (${p.promotion})` : ''}`).join(', ');
    const filePath = getFilePath(componentName, componentType);

    this.post({ type: 'status', message: `Fetching ${prLabel} and ${baseBranch} from GitHub…` });
    const branches = [...new Set([baseBranch, ...prs.map(p => p.targetBranch).filter(Boolean)])];
    gitFetchRefspecs([
      ...branches.map(b => `+refs/heads/${b}:refs/remotes/origin/${b}`),
      ...prs.map(p => `+refs/pull/${p.number}/head:refs/remotes/pr/${p.number}`),
    ], repoPath);

    const warnings: string[] = [...oldRepoNotes];
    if (baseBranchMissing) warnings.push(`${storyName} has no base branch set; used master`);
    if (!gitRefExists(`origin/${baseBranch}`, repoPath)) warnings.push(`base branch ${baseBranch} not found on GitHub, so its commits could not be excluded`);
    for (const t of new Set(prs.map(p => p.targetBranch).filter(Boolean))) {
      if (!gitRefExists(`origin/${t}`, repoPath)) warnings.push(`PR target branch ${t} no longer exists on GitHub`);
    }

    const commits = new Set<string>();
    const failed: string[] = [];
    let usedMerges = source === 'promo';
    for (const pr of prs) {
      if (source === 'promo') {
        const res = promoStoryCommits(pr, storyName, baseBranch, repoPath);
        if ('error' in res) { failed.push(`#${pr.number}: ${res.error}`); continue; }
        if (res.note) { warnings.push(res.note); usedMerges = false; }
        res.commits.forEach(c => commits.add(c));
        continue;
      }
      const res = prStoryCommits(pr, baseBranch, repoPath);
      if ('error' in res) { failed.push(`#${pr.number}: ${res.error}`); continue; }
      res.commits.forEach(c => commits.add(c));
    }
    if (failed.length === prs.length) {
      this.post({ type: 'notice', level: 'error', message: `Could not read ${prLabel} for ${storyName} — ${[...failed, ...oldRepoNotes].join('; ')}` });
      return;
    }
    if (failed.length > 0) warnings.push(`skipped ${failed.join('; ')}`);

    const unit = usedMerges ? 'merge commit' : 'story commit';
    this.post({ type: 'status', message: `Building diff for ${componentName} from ${commits.size} ${unit}(s)…` });
    // A merge's own diff is against its first parent; mixing in plain fallback commits uses the replay path for both.
    const d = usedMerges
      ? mergeCommitsFileDiff([...commits], filePath, repoPath)
      : storyOnlyFileDiff([...commits], filePath, repoPath);
    if (!d) {
      const msg = `${prLabel} (${commits.size} ${unit}${commits.size === 1 ? '' : 's'}) do${prs.length === 1 ? 'es' : ''} not change ${componentName} (${componentType}) — checked ${filePath}.`;
      this.post({ type: 'notice', level: 'info', message: msg + (warnings.length ? ` Note: ${warnings.join('; ')}.` : '') });
      return;
    }
    if (!d.exact) warnings.push('the commits did not replay cleanly, so the right side is the file at the newest story commit');

    const key = `${source}/${encodeURIComponent(storyName)}/${onlyPr ?? 'all'}/${encodeURIComponent(componentName)}`;
    const leftUri  = vscode.Uri.parse(`sfconflict:pr-before/${key}`);
    const rightUri = vscode.Uri.parse(`sfconflict:pr-after/${key}`);
    ReleaseCheckerPanel.gitProvider.set(leftUri.toString(), d.left);
    ReleaseCheckerPanel.gitProvider.set(rightUri.toString(), d.right);

    const title = `${storyName} → ${componentName}  (${source === 'promo' ? 'Promotion ' : ''}PR ${prLabel} · ${d.touching.length} ${unit}${d.touching.length === 1 ? '' : 's'})`;
    await this.showDiff(leftUri, rightUri, title);
    log(`PR diff ${storyName} ${componentName}: commits touching file = ${d.touching.map(c => c.slice(0, 10)).join(', ')}`);
    this.post(warnings.length
      ? { type: 'notice', level: 'warn', message: `Diff opened: ${componentName}. Note: ${warnings.join('; ')}.` }
      : { type: 'status', message: `Diff opened: ${componentName} (${d.touching.map(c => c.slice(0, 7)).join(', ')})`, spinner: false });
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private fetchStoriesForRelease(releaseId: string): Story[] {
    const records = queryOrg(
      `SELECT Id, Name, copado__Base_Branch__c, copado__View_in_Git__c FROM copado__User_Story__c WHERE copado__Release__c = '${releaseId}'`,
      this.orgAlias
    );
    return records.map(toStory);
  }

  // Mutates the stories in place so every component row sharing a story sees the same PR list.
  private attachPullRequests(stories: Story[]): void {
    const unique = [...new Map(stories.map(s => [s.id, s])).values()];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      try {
        const records = queryOrg(
          `SELECT copado__User_Story__c, copado__Request_Number__c, copado__State__c, copado__Merged__c, copado__Target_Branch__c, copado__Url__c FROM copado__Pull_Request__c WHERE copado__User_Story__c IN (${batch.map(s => `'${s.id}'`).join(',')}) ORDER BY copado__Request_Number__c`,
          this.orgAlias
        );
        for (const s of batch) s.prs = [];
        for (const r of records) {
          const s = batch.find(x => x.id === r['copado__User_Story__c']);
          const num = Number(r['copado__Request_Number__c']);
          if (!s || !num || s.prs!.some(p => p.number === num)) continue;
          s.prs!.push({
            number: num,
            state: String(r['copado__State__c'] ?? ''),
            merged: String(r['copado__Merged__c']) === 'true',
            targetBranch: String(r['copado__Target_Branch__c'] ?? ''),
            url: String(r['copado__Url__c'] ?? ''),
          });
        }
        for (const s of batch) {
          if (!s.repoUrl) s.repoUrl = repoUrlFrom(s.prs!.find(p => p.url)?.url ?? '');
        }
      } catch (e) {
        log(`Pull request lookup failed: ${String(e)}`);
        for (const s of batch) s.prLookupFailed = true;
      }
    }
  }

  // Promotion PRs: for teams that raise a PR from each promotion branch instead of the feature branch.
  // Results are kept per destination environment so the webview can show the story's next environment
  // (default) or any environment the user picks. A promotion qualifies only when it is Completed and its
  // latest SFDX Promote and latest SFDX Deploy job executions both succeeded.
  private attachPromotionPullRequests(stories: Story[]): void {
    const unique = [...new Map(stories.map(s => [s.id, s])).values()];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      try {
        const links = queryOrg(
          `SELECT copado__User_Story__c, copado__Promotion__c, copado__Promotion__r.Name, copado__Promotion__r.copado__Status__c, copado__Promotion__r.CreatedDate, copado__Promotion__r.copado__Source_Environment__c, copado__Promotion__r.copado__Destination_Environment__c, copado__Promotion__r.copado__Destination_Environment__r.Name FROM copado__Promoted_User_Story__c WHERE copado__User_Story__c IN (${batch.map(s => `'${s.id}'`).join(',')}) AND copado__Promotion__r.copado__Back_Promotion__c = false ORDER BY copado__Promotion__r.CreatedDate`,
          this.orgAlias
        );

        // The story's first forward promotion leaves its origin environment and lands in the next pipeline stage.
        type Candidate = { story: Story; env: string; promos: Array<{ id: string; name: string }> };
        const candidates: Candidate[] = [];
        for (const s of batch) {
          const mine = links.filter(r => val(r, 'copado__User_Story__c') === s.id);
          s.promoEnvs = {};
          if (mine.length === 0) { s.promoNote = 'Not promoted yet, so no qualified promotions, hence no PRs shown'; continue; }
          const envName = (r: SfRecord) => val(r, 'copado__Promotion__r.copado__Destination_Environment__r.Name') || 'Unnamed environment';
          s.nextEnv = envName(mine[0]);
          for (const env of [...new Set(mine.map(envName))]) {
            const toEnv = mine.filter(r => envName(r) === env);
            const completed = toEnv.filter(r => val(r, 'copado__Promotion__r.copado__Status__c') === 'Completed');
            s.promoEnvs[env] = { prs: [], promotions: [] };
            if (completed.length === 0) {
              s.promoEnvs[env].note = `No qualified promotions into ${env} (${toEnv.length} found, none Completed), hence no PRs shown`;
              continue;
            }
            candidates.push({
              story: s,
              env,
              promos: [...new Map(completed.map(r => [val(r, 'copado__Promotion__c'), val(r, 'copado__Promotion__r.Name')])).entries()]
                .map(([id, name]) => ({ id, name })),
            });
          }
        }

        const promoIds = [...new Set(candidates.flatMap(c => c.promos.map(p => p.id)))];
        const qualified = new Set<string>();
        const jobState = new Map<string, string>();
        for (let j = 0; j < promoIds.length; j += 100) {
          const ids = promoIds.slice(j, j + 100).map(id => `'${id}'`).join(',');
          // SFDX Promote jobs point at the promotion; SFDX Deploy jobs point at the promotion's Deployment record.
          const jobs = queryOrg(
            `SELECT copado__Promotion__c, copado__Deployment__r.copado__Promotion__c, copado__Status__c, copado__Template__r.Name, copado__Template__r.copado__ApiName__c FROM copado__JobExecution__c WHERE copado__Promotion__c IN (${ids}) OR copado__Deployment__r.copado__Promotion__c IN (${ids}) ORDER BY CreatedDate DESC`,
            this.orgAlias
          );
          const latest = new Map<string, { promote?: string; deploy?: string }>();
          for (const r of jobs) {
            const id = val(r, 'copado__Promotion__c') || val(r, 'copado__Deployment__r.copado__Promotion__c');
            const name = val(r, 'copado__Template__r.Name');
            const api = val(r, 'copado__Template__r.copado__ApiName__c');
            const entry = latest.get(id) ?? {};
            if (entry.promote === undefined && isTemplate(name, api, 'promote')) entry.promote = val(r, 'copado__Status__c');
            if (entry.deploy === undefined && isTemplate(name, api, 'deploy')) entry.deploy = val(r, 'copado__Status__c');
            latest.set(id, entry);
          }
          for (const [id, e] of latest) {
            const state = `latest SFDX Promote: ${e.promote ?? 'none'}, latest SFDX Deploy: ${e.deploy ?? 'none'}`;
            log(`Promotion ${id}: ${state}`);
            jobState.set(id, state);
            if (e.promote === 'Successful' && e.deploy === 'Successful') qualified.add(id);
          }
        }

        const okPromos = new Map<string, string>();
        for (const c of candidates) {
          const result = c.story.promoEnvs![c.env];
          const ok = c.promos.filter(p => qualified.has(p.id));
          if (ok.length === 0) {
            result.note = `No qualified promotions into ${c.env} (${c.promos.map(p => `${p.name}: ${jobState.get(p.id) ?? 'no SFDX Promote or SFDX Deploy job found'}`).join('; ')}), hence no PRs shown`;
            continue;
          }
          result.promotions = ok.map(p => p.name);
          ok.forEach(p => okPromos.set(p.id, p.name));
        }

        const okIds = [...okPromos.keys()];
        const prsByPromo = new Map<string, PullRequest[]>();
        for (let j = 0; j < okIds.length; j += 100) {
          const ids = okIds.slice(j, j + 100).map(id => `'${id}'`).join(',');
          const recs = queryOrg(
            `SELECT copado__Promotion__c, copado__Request_Number__c, copado__State__c, copado__Merged__c, copado__Target_Branch__c, copado__Url__c FROM copado__Promotion_Pull_Request__c WHERE copado__Promotion__c IN (${ids}) ORDER BY copado__Request_Number__c`,
            this.orgAlias
          );
          for (const r of recs) {
            const id = val(r, 'copado__Promotion__c');
            const num = Number(val(r, 'copado__Request_Number__c'));
            const list = prsByPromo.get(id) ?? [];
            if (!num || list.some(p => p.number === num)) continue;
            list.push({
              number: num,
              state: val(r, 'copado__State__c'),
              merged: val(r, 'copado__Merged__c') === 'true',
              targetBranch: val(r, 'copado__Target_Branch__c'),
              url: val(r, 'copado__Url__c'),
              promotion: okPromos.get(id),
            });
            prsByPromo.set(id, list);
          }
        }

        for (const c of candidates) {
          const result = c.story.promoEnvs![c.env];
          if (!result.promotions.length) continue;
          result.prs = c.promos.filter(p => qualified.has(p.id)).flatMap(p => prsByPromo.get(p.id) ?? []);
          const n = result.promotions.length;
          if (result.prs.length === 0) result.note = `Qualified promotion${n > 1 ? 's' : ''} ${result.promotions.join(', ')} into ${c.env} ha${n > 1 ? 've' : 's'} no PR raised`;
          if (!c.story.repoUrl) c.story.repoUrl = repoUrlFrom(result.prs.find(p => p.url)?.url ?? '');
        }
      } catch (e) {
        log(`Promotion pull request lookup failed: ${String(e)}`);
        for (const s of batch) s.promoLookupFailed = true;
      }
    }
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

  private getHtml(initialOrg = '', prefs: SavedPrefs = {}): string {
    const safeOrg = initialOrg.replace(/"/g, '&quot;');
    const savedJson = JSON.stringify(prefs).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Release Conflict Checker</title>
<style>
  /* Every colour comes from the active VS Code theme, so the panel follows light, dark and high-contrast themes. */
  :root{
    --bg:var(--vscode-editor-background);
    --rail:var(--vscode-sideBar-background, var(--vscode-editor-background));
    --fg:var(--vscode-foreground);
    --muted:var(--vscode-descriptionForeground);
    --line:var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.35)));
    --card:var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --hover:var(--vscode-list-hoverBackground);
    --sel:var(--vscode-list-inactiveSelectionBackground);
    --accent:var(--vscode-button-background);
    --accent-fg:var(--vscode-button-foreground);
    --accent-hover:var(--vscode-button-hoverBackground);
    --sec:var(--vscode-button-secondaryBackground, transparent);
    --sec-fg:var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    --sec-hover:var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    --input:var(--vscode-input-background);
    --input-fg:var(--vscode-input-foreground);
    --input-line:var(--vscode-input-border, var(--line));
    --focus:var(--vscode-focusBorder);
    --link:var(--vscode-textLink-foreground);
    --badge:var(--vscode-badge-background);
    --badge-fg:var(--vscode-badge-foreground);
    --ok:var(--vscode-testing-iconPassed, #73c991);
    --warn:var(--vscode-editorWarning-foreground, #cca700);
    --err:var(--vscode-errorForeground, #f48771);
    --info:var(--vscode-editorInfo-foreground, #3794ff);
    --mono:var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    --placeholder:var(--vscode-input-placeholderForeground);
    --promote:var(--vscode-charts-blue, #3794ff);
    --future:var(--vscode-charts-purple, #b180d7);
  }
  /* Panel-only theme override; "auto" leaves the VS Code theme in charge. */
  :root[data-theme="dark"]{
    color-scheme:dark;
    --bg:#1f1f1f; --rail:#181818; --fg:#cccccc; --muted:#9d9d9d; --line:#2b2b2b; --card:#202020;
    --hover:#2a2d2e; --sel:#37373d; --accent:#0078d4; --accent-fg:#ffffff; --accent-hover:#026ec1;
    --sec:#313131; --sec-fg:#cccccc; --sec-hover:#3c3c3c; --input:#313131; --input-fg:#cccccc; --input-line:#3c3c3c;
    --focus:#0078d4; --link:#4daafc; --badge:#616161; --badge-fg:#f8f8f8; --placeholder:#989898;
    --ok:#73c991; --warn:#cca700; --err:#f48771; --info:#3794ff; --promote:#3794ff; --future:#b180d7;
  }
  :root[data-theme="light"]{
    color-scheme:light;
    --bg:#ffffff; --rail:#f8f8f8; --fg:#3b3b3b; --muted:#6e6e6e; --line:#e5e5e5; --card:#ffffff;
    --hover:#f2f2f2; --sel:#e8e8e8; --accent:#005fb8; --accent-fg:#ffffff; --accent-hover:#0258a8;
    --sec:#e5e5e5; --sec-fg:#3b3b3b; --sec-hover:#cccccc; --input:#ffffff; --input-fg:#3b3b3b; --input-line:#cecece;
    --focus:#005fb8; --link:#005fb8; --badge:#cccccc; --badge-fg:#3b3b3b; --placeholder:#767676;
    --ok:#388a34; --warn:#9a6700; --err:#c72e0f; --info:#1a85ff; --promote:#1a6fd6; --future:#8a4fbf;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);font-size:var(--vscode-font-size, 13px);line-height:1.5;background:var(--bg);color:var(--fg)}
  .app{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:100vh}
  .stack > * + *{margin-top:16px}

  /* ── Side rail ── */
  .rail{background:var(--rail);border-right:1px solid var(--line);padding:16px;position:sticky;top:0;height:100vh;overflow-y:auto}
  .brand{font-weight:600;font-size:14px}
  .brand small{display:block;font-weight:400;font-size:11px;color:var(--muted);margin-top:2px}
  .lab{display:flex;align-items:baseline;gap:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
  .lab .cnt{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:var(--link)}
  .org-row{display:flex;gap:6px}
  .org-wrap{position:relative;flex:1;min-width:0}
  .org-dot{position:absolute;left:9px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:var(--muted);opacity:.45}
  .org-dot.on{background:var(--ok);opacity:1}
  input[type=text],input[type=search]{width:100%;background:var(--input);color:var(--input-fg);border:1px solid var(--input-line);border-radius:2px;padding:5px 8px;font:inherit;outline:none}
  input[type=text]:focus,input[type=search]:focus{border-color:var(--focus);outline:1px solid var(--focus);outline-offset:-1px}
  select{width:100%;background:var(--input);color:var(--input-fg);border:1px solid var(--input-line);border-radius:2px;padding:4px 6px;font:inherit;outline:none}
  select:focus{border-color:var(--focus);outline:1px solid var(--focus);outline-offset:-1px}
  input::placeholder{color:var(--placeholder)}
  .org-input{font-family:var(--mono);padding-left:22px !important}
  .mono-input{font-family:var(--mono)}
  .seg{display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;border:1px solid var(--line);border-radius:3px}
  .tab{text-align:center;padding:4px;border-radius:2px;cursor:pointer;color:var(--muted);user-select:none}
  .tab:hover{color:var(--fg);background:var(--hover)}
  .tab.active{background:var(--accent);color:var(--accent-fg)}
  .pick-group{--g:var(--promote);border:1px solid var(--line);border-left:3px solid var(--g);border-radius:3px;padding:10px;background:color-mix(in srgb, var(--g) 5%, transparent)}
  .pick-group.future{--g:var(--future)}
  .pick-group .lab{color:var(--g)}
  .pick-group .lab svg{flex-shrink:0;align-self:center}
  .pick-group .lab .cnt{white-space:nowrap;color:var(--g);background:color-mix(in srgb, var(--g) 16%, transparent);border-radius:10px;padding:0 7px}
  .pick-group .lab .cnt:empty{display:none}
  .pick-hint{font-size:11px;color:var(--muted);margin:-3px 0 6px}
  .pick-filter{margin-bottom:4px}
  .pick-list{max-height:200px;overflow-y:auto;border:1px solid var(--line);border-radius:2px;background:var(--bg)}
  .pick{display:flex;gap:8px;align-items:flex-start;padding:4px 8px;cursor:pointer;border-left:2px solid transparent}
  .pick:hover{background:var(--hover)}
  .pick input{margin-top:3px;accent-color:var(--g);flex-shrink:0}
  .pick .nm{display:block;overflow-wrap:anywhere}
  .pick .meta{display:block;font-size:11px;color:var(--muted)}
  .pick.on{background:color-mix(in srgb, var(--g) 14%, transparent);border-left-color:var(--g)}
  .pick.on .nm{font-weight:600}
  .pick.taken{opacity:.5;cursor:default}
  .pick-empty{padding:8px;font-size:12px;color:var(--muted)}
  .field label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}

  /* ── Buttons ── */
  .btn{background:var(--accent);color:var(--accent-fg);border:1px solid var(--vscode-button-border, transparent);border-radius:2px;padding:5px 12px;font:inherit;cursor:pointer;white-space:nowrap}
  .btn:hover{background:var(--accent-hover)}
  .btn:focus-visible{outline:1px solid var(--focus);outline-offset:2px}
  .btn:disabled{opacity:.5;cursor:default}
  .btn-block{width:100%;padding:7px 12px;font-weight:600}
  .btn-sec{background:var(--sec);color:var(--sec-fg);border-color:var(--vscode-button-border, var(--line))}
  .btn-sec:hover{background:var(--sec-hover)}
  .btn-sm{padding:2px 9px;font-size:12px}
  .btn-pr{background:var(--sec);color:var(--sec-fg);border-color:var(--vscode-button-border, var(--line))}
  .btn-pr:hover{background:var(--sec-hover)}

  /* ── Main area ── */
  .main{padding:20px 24px 40px;min-width:0}
  .status-bar{display:none;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--line);border-left:3px solid var(--info);border-radius:3px;font-size:12px}
  .status-bar.show{display:flex}
  .status-info{border-left-color:var(--info);background:color-mix(in srgb, var(--info) 9%, transparent)}
  .status-success{border-left-color:var(--ok);background:color-mix(in srgb, var(--ok) 9%, transparent)}
  .status-warn{border-left-color:var(--warn);background:color-mix(in srgb, var(--warn) 10%, transparent)}
  .status-error{border-left-color:var(--err);background:color-mix(in srgb, var(--err) 10%, transparent)}
  .spinner{width:14px;height:14px;flex-shrink:0;border:2px solid color-mix(in srgb, var(--fg) 20%, transparent);border-top-color:var(--focus);border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .empty{border:1px dashed var(--line);border-radius:4px;padding:48px 24px;text-align:center;color:var(--muted)}
  .empty b{display:block;color:var(--fg);font-size:14px;font-weight:600;margin-bottom:4px}
  .empty svg{display:block;margin:0 auto 12px;opacity:.6}

  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:4px;overflow:hidden}
  .kpi{background:var(--card);padding:10px 14px}
  .kpi b{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
  .kpi span{font-size:11px;color:var(--muted)}
  .kpi.warn b{color:var(--warn)}
  .kpi.ok b{color:var(--ok)}
  .results-header{display:flex;align-items:center;gap:8px}
  .results-title{font-weight:600}
  .results-badge{background:var(--badge);color:var(--badge-fg);border-radius:10px;padding:0 7px;min-width:20px;text-align:center;font-size:11px;font-weight:600}
  .results-header .sp{flex:1}

  .component-list{display:flex;flex-direction:column;gap:6px}
  .component-item{border:1px solid var(--line);border-radius:4px;background:var(--card)}
  /* Fixed trailing columns keep type badges, counts and risk dots aligned across rows. */
  .component-header{display:grid;grid-template-columns:12px minmax(0,1fr) 190px 70px 8px;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;user-select:none}
  .component-header:hover{background:var(--hover)}
  .component-chevron{display:inline-flex;color:var(--muted);transition:transform .15s}
  .component-chevron.open{transform:rotate(90deg)}
  .component-name{font-family:var(--mono);flex:1;min-width:0;overflow-wrap:anywhere}
  .component-type{justify-self:start;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:11px;background:var(--badge);color:var(--badge-fg);border-radius:10px;padding:0 8px;white-space:nowrap}
  .component-count{font-size:12px;color:var(--muted);white-space:nowrap;text-align:right}
  .risk{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .risk-high{background:var(--err)}
  .risk-med{background:var(--warn)}
  .risk-low{background:var(--ok)}
  .component-stories{display:none;border-top:1px solid var(--line);padding:0 12px 0 34px}
  .component-stories.open{display:block}
  .story-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px dashed var(--line)}
  .story-row:last-child{border-bottom:0}
  .story-info{display:flex;flex-direction:column;gap:3px;min-width:0}
  .story-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .story-name{font-family:var(--mono);font-weight:600}
  .story-name a,.story-branch a{color:var(--link);text-decoration:none}
  .story-name a:hover,.story-branch a:hover{text-decoration:underline}
  .story-release-tag{font-size:11px;color:var(--future);border:1px solid color-mix(in srgb, var(--future) 45%, transparent);background:color-mix(in srgb, var(--future) 10%, transparent);border-radius:10px;padding:0 7px}
  .topbar{display:flex;align-items:center;gap:12px;min-height:26px}
  .topbar .crumb{flex:1;min-width:0;font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
  .crumb .c-p{color:var(--promote);font-weight:600}
  .crumb .c-f{color:var(--future);font-weight:600}
  .theme-toggle{display:inline-flex;border:1px solid var(--line);border-radius:3px;padding:2px;gap:2px;flex-shrink:0}
  .theme-toggle button{display:inline-flex;align-items:center;gap:5px;background:none;border:0;color:var(--muted);padding:3px 8px;border-radius:2px;font:inherit;font-size:12px;cursor:pointer}
  .theme-toggle button:hover{color:var(--fg);background:var(--hover)}
  .theme-toggle button:focus-visible{outline:1px solid var(--focus)}
  .theme-toggle button[aria-pressed="true"]{background:var(--accent);color:var(--accent-fg)}
  .prefs-state{font-size:11px;color:var(--muted);flex-shrink:0;white-space:nowrap}
  #btnSavePrefs{flex-shrink:0}
  #btnSavePrefs:disabled{opacity:.5;cursor:default}
  .story-branch{font-size:12px;color:var(--muted);font-family:var(--mono);overflow-wrap:anywhere}
  .story-no-branch,.story-no-pr,.no-branch{font-size:12px;color:var(--warn)}
  .story-prs{display:flex;flex-wrap:wrap;gap:4px}
  .pr-pill{font-size:11px;font-family:var(--mono);color:var(--fg);text-decoration:none;border-radius:3px;padding:0 6px;background:color-mix(in srgb, var(--info) 16%, transparent)}
  .pr-pill.pr-merged{background:color-mix(in srgb, var(--ok) 18%, transparent)}
  .pr-pill.pr-closed{background:color-mix(in srgb, var(--err) 16%, transparent)}
  a.pr-pill:hover{text-decoration:underline}
  .story-actions{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0;max-width:45%}
  .no-common{padding:32px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:4px}
  .no-common b{display:block;color:var(--ok);font-size:14px;margin-bottom:4px}
  .legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:8px}

  @media (max-width:720px){
    .app{grid-template-columns:1fr}
    .rail{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}
    .main{padding:16px}
  }
</style>
</head>
<body>
<div class="app">

<aside class="rail stack">
  <div class="brand">Release Conflict Checker<small>Shared metadata between releases or stories</small></div>

  <div>
    <div class="lab">Salesforce org</div>
    <div class="org-row">
      <div class="org-wrap">
        <span class="org-dot" id="orgDot"></span>
        <input id="orgAlias" class="org-input" type="text" value="${safeOrg}" placeholder="Org alias, e.g. RBKINT-CPQAI" autocomplete="off"/>
      </div>
      <button class="btn" onclick="connectOrg()">Connect</button>
    </div>
  </div>

  <div id="modeCard" class="stack" style="display:none">
    <div>
      <div class="lab">Mode</div>
      <div class="seg">
        <div class="tab active" id="tabRelease" onclick="switchMode('release')">By release</div>
        <div class="tab" id="tabStory" onclick="switchMode('story')">By user story</div>
      </div>
    </div>

    <div>
      <div class="lab">PR source</div>
      <div class="seg">
        <div class="tab active" id="srcFeature" onclick="setPrSource('feature')" title="PRs raised from the story's feature branch">Feature branch</div>
        <div class="tab" id="srcPromo" onclick="setPrSource('promo')" title="PRs raised from promotion branches into the story's next environment">Promotion</div>
      </div>
      <div class="pick-hint" id="srcHint" style="margin:5px 0 0">PRs raised from each story's feature branch</div>
      <div id="envPick" style="display:none;margin-top:8px">
        <label class="lab" for="promoEnvSel">Target environment</label>
        <select id="promoEnvSel" onchange="setPromoEnv(this.value)"></select>
        <div class="pick-hint" id="envHint" style="margin:5px 0 0"></div>
      </div>
    </div>

    <div id="releaseMode" class="stack">
      <div class="pick-group promote">
        <div class="lab"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>Releases to promote <span class="cnt" id="promoteCount"></span></div>
        <div class="pick-hint">What's going out now</div>
        <input type="search" id="promoteFilter" class="pick-filter" placeholder="Filter releases" oninput="renderPick('promote')"/>
        <div class="pick-list" id="promoteList" onchange="onPick(event, 'promote')"></div>
      </div>
      <div class="pick-group future">
        <div class="lab"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>Future planned releases <span class="cnt" id="futureCount"></span></div>
        <div class="pick-hint">Checked for overlap with the release being promoted</div>
        <input type="search" id="futureFilter" class="pick-filter" placeholder="Filter releases" oninput="renderPick('future')"/>
        <div class="pick-list" id="futureList" onchange="onPick(event, 'future')"></div>
      </div>
      <button class="btn btn-block" onclick="analyseReleases()" id="btnAnalyseReleases">Analyse common components</button>
    </div>

    <div id="storyMode" class="stack" style="display:none">
      <div class="field">
        <label for="story1Input">User story 1</label>
        <input id="story1Input" class="mono-input" type="text" placeholder="e.g. US-0030781" autocomplete="off"/>
      </div>
      <div class="field">
        <label for="story2Input">User story 2</label>
        <input id="story2Input" class="mono-input" type="text" placeholder="e.g. US-0029093" autocomplete="off"/>
      </div>
      <button class="btn btn-block" onclick="analyseStories()" id="btnAnalyseStories">Compare stories</button>
    </div>
  </div>
</aside>

<main class="main stack">
  <div class="topbar">
    <div class="crumb" id="crumb"></div>
    <div class="theme-toggle" role="group" aria-label="Panel theme">
      <button type="button" data-theme-btn="auto" title="Follow the VS Code theme"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>Auto</button>
      <button type="button" data-theme-btn="light" title="Light"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.4"/></svg>Light</button>
      <button type="button" data-theme-btn="dark" title="Dark"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 10A6 6 0 0 1 6 3a6 6 0 1 0 7 7z" fill="currentColor"/></svg>Dark</button>
    </div>
    <span class="prefs-state" id="prefsState"></span>
    <button class="btn btn-sec btn-sm" id="btnSavePrefs" onclick="savePrefs()" title="Open the checker with the current PR source, mode and theme every time">Save settings</button>
  </div>
  <div class="status-bar status-info" id="statusBar">
    <div class="spinner" id="statusSpinner"></div>
    <span id="statusText"></span>
  </div>

  <div class="empty" id="emptyState">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11 7"/></svg>
    <b>No analysis yet</b>
    Connect to an org, choose the release to promote and the future releases, then run Analyse.
  </div>

  <div id="resultsSection" class="stack" style="display:none">
    <div class="kpis" id="statRow"></div>
    <div class="results-header">
      <span class="results-title">Shared components</span>
      <span class="results-badge" id="commonBadge">0</span>
      <span class="sp"></span>
      <button class="btn btn-sec btn-sm" id="btnToggleAll" onclick="toggleAll()">Expand all</button>
      <button class="btn btn-sec btn-sm" onclick="resetAll()">Reset</button>
    </div>
    <div id="componentList" class="component-list"></div>
    <div class="legend" id="legend"></div>
  </div>
</main>

</div>


<script>
  const vscode = acquireVsCodeApi();
  let SAVED = ${savedJson};
  let currentMode = 'release';
  let currentTheme = SAVED.theme || (vscode.getState() || {}).theme || 'auto';
  let _prSource = (SAVED.prSource || (vscode.getState() || {}).prSource) === 'promo' ? 'promo' : 'feature';
  let _promoEnv = SAVED.promoEnv || '';
  let _last = null;

  function currentPrefs() {
    return { prSource: _prSource, mode: currentMode, theme: currentTheme, promoEnv: _promoEnv };
  }

  function refreshPrefsState() {
    const cur = currentPrefs();
    const hasSaved = !!SAVED.prSource;
    const same = hasSaved && cur.prSource === SAVED.prSource && cur.mode === SAVED.mode && cur.theme === SAVED.theme && cur.promoEnv === (SAVED.promoEnv || '');
    const btn = document.getElementById('btnSavePrefs');
    btn.disabled = same;
    document.getElementById('prefsState').textContent = same ? 'Settings saved' : hasSaved ? 'Unsaved changes' : '';
  }

  function savePrefs() {
    vscode.postMessage({ command: 'savePrefs', prefs: currentPrefs() });
  }

  // Which environment a story's promotion PRs come from: the picked one, or the story's own next environment.
  const envOf = s => _promoEnv || s.nextEnv || '';
  const promoOf = s => {
    const env = envOf(s);
    const r = (s.promoEnvs || {})[env];
    if (r) return Object.assign({ env }, r);
    if (!s.promoEnvs || !Object.keys(s.promoEnvs).length) return { env, prs: [], promotions: [], note: s.promoNote };
    return { env, prs: [], promotions: [], note: 'Not promoted to ' + env + ', so no qualified promotions, hence no PRs shown' };
  };
  const prsOf = s => (_prSource === 'promo' ? promoOf(s).prs : s.prs) || [];
  const lookupFailed = s => _prSource === 'promo' ? !!s.promoLookupFailed : !!s.prLookupFailed;

  function setPrSource(src) {
    _prSource = src === 'promo' ? 'promo' : 'feature';
    document.getElementById('srcFeature').classList.toggle('active', _prSource === 'feature');
    document.getElementById('srcPromo').classList.toggle('active', _prSource === 'promo');
    document.getElementById('srcHint').textContent = _prSource === 'promo'
      ? 'PRs from Completed promotions into the environment right after the story\\'s origin (latest SFDX Promote and SFDX Deploy successful)'
      : 'PRs raised from each story\\'s feature branch';
    document.getElementById('legend').innerHTML = _prSource === 'promo'
      ? '<span>Promotion PR diff: only the commit merging the story into the promotion branch</span><span>#N: one promotion PR</span><span>All PRs Diff: all qualified promotions combined</span>'
      : '<span>PR diff: only the story\\'s own PR commits, base-branch commits excluded</span><span>#N: one PR</span><span>Branch diff (no PR): feature branch vs base branch</span>';
    document.getElementById('envPick').style.display = _prSource === 'promo' ? 'block' : 'none';
    vscode.setState(Object.assign({}, vscode.getState() || {}, { prSource: _prSource }));
    refreshPrefsState();
    if (_last) renderResults(_last.components, _last.mode);
  }

  function setPromoEnv(env) {
    _promoEnv = env || '';
    document.getElementById('envHint').textContent = '';
    refreshPrefsState();
    if (_last) renderResults(_last.components, _last.mode);
  }

  // Options come from the environments the analysed stories were promoted into, in pipeline-ish order
  // (by how early each environment appears in a story's promotion history).
  function renderEnvOptions(components) {
    const rank = new Map();
    components.forEach(c => c.excludeStories.forEach(s => {
      Object.keys(s.promoEnvs || {}).forEach((env, i) => rank.set(env, Math.min(rank.has(env) ? rank.get(env) : 99, i)));
    }));
    const envs = [...rank.keys()].sort((a, b) => rank.get(a) - rank.get(b) || a.localeCompare(b));
    let fellBack = '';
    if (_promoEnv && !envs.includes(_promoEnv)) {
      // Before any analysis there is nothing to compare against, so keep the saved choice.
      if (components.length) { fellBack = _promoEnv; _promoEnv = ''; }
      else envs.push(_promoEnv);
    }
    document.getElementById('envHint').textContent = fellBack
      ? 'No analysed story was promoted to ' + fellBack + ', showing each story\\'s next environment'
      : '';
    document.getElementById('promoEnvSel').innerHTML =
      '<option value="">Next environment (auto)</option>' +
      envs.map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('');
    document.getElementById('promoEnvSel').value = _promoEnv;
  }

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
    showResultsArea(false);
    clearStatus();
    renderCrumb();
    refreshPrefsState();
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

  function releaseMeta(r) {
    const bits = [];
    if (r.status) bits.push(r.status);
    if (r.storyCount > 0) bits.push(r.storyCount + ' stor' + (r.storyCount === 1 ? 'y' : 'ies'));
    return bits.join(' · ');
  }

  function renderPick(list) {
    const other = list === 'promote' ? 'future' : 'promote';
    const q = (document.getElementById(list + 'Filter').value || '').trim().toLowerCase();
    const mine = new Set(_picked[list]);
    const theirs = new Set(_picked[other]);
    const rows = _releases.filter(r => mine.has(r.id) || !q || releaseLabel(r).toLowerCase().includes(q));
    const otherName = list === 'promote' ? 'future' : 'promote';
    document.getElementById(list + 'List').innerHTML = rows.length
      ? rows.map(r => {
          const on = mine.has(r.id), taken = theirs.has(r.id);
          return '<label class="pick' + (on ? ' on' : '') + (taken ? ' taken' : '') + '"' + (taken ? ' title="Already picked as a ' + otherName + ' release"' : '') + '>' +
            '<input type="checkbox" value="' + esc(r.id) + '"' + (on ? ' checked' : '') + (taken ? ' disabled' : '') + '/>' +
            '<span><span class="nm">' + esc(r.name) + '</span>' + (releaseMeta(r) ? '<span class="meta">' + esc(releaseMeta(r)) + '</span>' : '') + '</span></label>';
        }).join('')
      : '<div class="pick-empty">' + (_releases.length ? 'No releases match' : 'No releases loaded') + '</div>';
    document.getElementById(list + 'Count').textContent = _picked[list].length ? _picked[list].length + ' selected' : '';
  }

  function renderReleasePickers() {
    renderPick('promote');
    renderPick('future');
    renderCrumb();
  }

  function renderCrumb() {
    const el = document.getElementById('crumb');
    const nameOf = id => esc((_releases.find(r => r.id === id) || {}).name || id);
    if (currentMode !== 'release' || !_picked.promote.length) { el.innerHTML = ''; return; }
    el.innerHTML = 'Promoting <span class="c-p">' + _picked.promote.map(nameOf).join(', ') + '</span>' +
      (_picked.future.length ? ' against <span class="c-f">' + _picked.future.map(nameOf).join(', ') + '</span>' : '');
  }

  function applyTheme(mode) {
    currentTheme = mode === 'light' || mode === 'dark' ? mode : 'auto';
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    document.querySelectorAll('[data-theme-btn]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeBtn === (mode || 'auto'))));
  }

  function onPick(e, list) {
    const box = e.target;
    if (!box || box.type !== 'checkbox') return;
    _picked[list] = box.checked ? [..._picked[list], box.value] : _picked[list].filter(id => id !== box.value);
    renderReleasePickers();
  }

  function toggleAll() {
    const btn = document.getElementById('btnToggleAll');
    const open = btn.textContent === 'Expand all';
    document.querySelectorAll('.component-stories').forEach(el => el.classList.toggle('open', open));
    document.querySelectorAll('.component-chevron').forEach(el => el.classList.toggle('open', open));
    btn.textContent = open ? 'Collapse all' : 'Expand all';
  }

  function showResultsArea(show) {
    document.getElementById('resultsSection').style.display = show ? 'block' : 'none';
    document.getElementById('emptyState').style.display = show ? 'none' : 'block';
  }

  function analyseReleases() {
    const promoteIds = [..._picked.promote];
    const excludeIds = [..._picked.future];
    const nameOf = id => (_releases.find(r => r.id === id) || {}).name || id;
    if (promoteIds.length === 0) { showStatus('Please add at least one Release to Promote.', 'error'); return; }
    if (excludeIds.length === 0) { showStatus('Please add at least one Future Planned Release.', 'error'); return; }
    showStatus('Fetching stories and metadata for ' + promoteIds.length + ' release(s) to promote and ' + excludeIds.length + ' future planned release(s)…', 'info', true);
    showResultsArea(false);
    document.getElementById('btnAnalyseReleases').disabled = true;
    vscode.postMessage({ command: 'analyseReleases', promoteIds, excludeIds, excludeNames: excludeIds.map(nameOf) });
  }

  function analyseStories() {
    const story1 = document.getElementById('story1Input').value.trim().toUpperCase();
    const story2 = document.getElementById('story2Input').value.trim().toUpperCase();
    if (!story1 || !story2) { showStatus('Please enter both story names.', 'error'); return; }
    if (story1 === story2) { showStatus('Please enter two different story names.', 'error'); return; }
    showStatus('Looking up stories and fetching metadata…', 'info', true);
    showResultsArea(false);
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
    showResultsArea(false);
    document.getElementById('componentList').innerHTML = '';
    _last = null;
    document.getElementById('orgDot').classList.remove('on');
    document.getElementById('promoteFilter').value = '';
    document.getElementById('futureFilter').value = '';
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

  function viewDiff(storyName, baseBranch, featureBranch, componentName, componentType, repoUrl) {
    showStatus('Checking branch and opening diff for ' + componentName + ' (' + storyName + ')…', 'info', true);
    scrollToStatus(); // scroll immediately so user sees the spinner right away
    vscode.postMessage({ command: 'viewDiff', storyName, repoUrl: repoUrl || '', baseBranch, featureBranch, componentName, componentType });
  }

  let _rows = [];

  function prDiff(row, prNumber) {
    const r = _rows[row];
    if (!r) return;
    const prs = prsOf(r.s);
    const kind = _prSource === 'promo' ? 'promotion ' : '';
    const label = prNumber === null ? (prs.length > 1 ? 'all ' + kind + 'PRs' : kind + 'PR #' + prs[0].number) : kind + 'PR #' + prNumber;
    showStatus('Reading ' + label + ' for ' + r.comp.name + ' (' + r.s.name + ')…', 'info', true);
    scrollToStatus();
    vscode.postMessage({
      command: 'viewPrDiff', storyName: r.s.name, repoUrl: r.s.repoUrl, baseBranch: r.s.baseBranch, baseBranchMissing: r.s.baseBranchMissing,
      prs, prNumber, componentName: r.comp.name, componentType: r.comp.type, source: _prSource,
    });
  }

  function branchDiff(row) {
    const r = _rows[row];
    if (r) viewDiff(r.s.name, r.s.baseBranch, r.s.featureBranch, r.comp.name, r.comp.type, r.s.repoUrl);
  }

  function prInfoHtml(s) {
    const repo = s.repoUrl ? '<div class="story-branch">Repo: ' + esc(s.repoUrl.replace(/^https?:\\/\\/[^/]+\\//, '')) + '</div>' : '';
    const promo = _prSource === 'promo';
    const warn = repo + (s.baseBranchMissing && !promo ? '<div class="story-no-branch">⚠ No base branch on story — comparing with master</div>' : '');
    if (lookupFailed(s)) return warn + '<div class="story-no-branch">⚠ Could not read ' + (promo ? 'promotions' : 'pull requests') + '</div>';
    const prs = prsOf(s);
    const pr = promo ? promoOf(s) : null;
    const via = pr && pr.promotions.length
      ? '<div class="story-branch">Promotions → ' + esc(pr.env) + ': ' + pr.promotions.map(esc).join(', ') + '</div>' : '';
    if (prs.length === 0) return warn + via + '<div class="story-no-pr">' + esc(pr ? (pr.note || 'No qualified promotions, hence no PRs shown') : 'No PR raised') + '</div>';
    return warn + via + '<div class="story-prs">' + prs.map(p => {
      const state = p.merged ? 'Merged' : (p.state || 'Open');
      const cls = 'pr-pill pr-' + String(state).toLowerCase();
      const text = '#' + p.number + (p.promotion ? ' ' + esc(p.promotion) : '') + ' ' + esc(String(state).toLowerCase()) + (p.targetBranch ? ' → ' + esc(p.targetBranch) : '');
      return /^https?:\\/\\//.test(p.url)
        ? '<a href="#" class="' + cls + '" data-url="' + esc(p.url) + '" onclick="openUrl(this.dataset.url);return false;">' + text + '</a>'
        : '<span class="' + cls + '">' + text + '</span>';
    }).join('') + '</div>';
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
    const badge = document.getElementById('commonBadge');
    const list = document.getElementById('componentList');
    const statRow = document.getElementById('statRow');

    badge.textContent = components.length;
    showResultsArea(true);
    document.getElementById('btnToggleAll').textContent = 'Expand all';
    document.getElementById('btnToggleAll').style.display = components.length ? '' : 'none';

    const allStories = new Map(components.flatMap(c => c.excludeStories.map(s => [s.name, s])));
    const noPr = [...allStories.values()].filter(s => !lookupFailed(s) && !prsOf(s).length).length;
    const futureReleaseNames = [...new Set(components.flatMap(c => c.excludeStories.map(s => s.releaseName).filter(Boolean)))];
    const kpi = (n, label, cls) => '<div class="kpi' + (cls ? ' ' + cls : '') + '"><b>' + n + '</b><span>' + label + '</span></div>';
    statRow.innerHTML =
      kpi(components.length, 'Shared components', components.length ? '' : 'ok') +
      (mode === 'release' ? kpi(futureReleaseNames.length, 'Future releases affected') : '') +
      kpi(allStories.size, mode === 'story' ? 'Stories involved' : 'Future-release stories') +
      kpi(noPr, _prSource === 'promo' ? 'Stories without a promotion PR' : 'Stories without a PR', noPr ? 'warn' : '');

    if (components.length === 0) {
      list.innerHTML = '<div class="no-common"><b>No shared components</b>Both sides touch completely separate metadata.</div>';
      return;
    }

    _rows = [];
    list.innerHTML = components.map((comp, idx) => {
      const storyRows = comp.excludeStories.map(s => {
        const hasBranch = !!(s.featureBranch && s.featureBranch.length > 0);
        const prs = prsOf(s);
        const promo = _prSource === 'promo';
        const row = _rows.push({ s, comp }) - 1;
        let actions;
        if (prs.length > 0) {
          actions =
            '<button class="btn btn-sm btn-diff" title="' + (promo ? 'Changes to this component from the story merges in all qualified promotion PRs' : 'Changes to this component across all PRs, story commits only') + '" onclick="prDiff(' + row + ',null)">' +
              (prs.length > 1 ? 'All PRs Diff' : 'PR Diff') + '</button>' +
            (prs.length > 1
              ? prs.map(p => '<button class="btn btn-sm btn-pr" title="Only PR #' + p.number + (p.promotion ? ' (' + esc(p.promotion) + ')' : '') + '" onclick="prDiff(' + row + ',' + p.number + ')">#' + p.number + '</button>').join('')
              : '');
        } else if (promo) {
          actions = '<span class="no-branch">No promotion PR</span>';
        } else if (hasBranch) {
          actions = '<button class="btn btn-sm btn-pr" title="No PR — falls back to the feature branch vs base branch diff" onclick="branchDiff(' + row + ')">Branch Diff</button>';
        } else {
          actions = '<span class="no-branch">No branch</span>';
        }
        return '<div class="story-row" id="story-row-' + esc(s.name) + '-' + idx + '">' +
          '<div class="story-info">' +
            '<div class="story-top"><span class="story-name">' + storyNameHtml(s) + '</span>' +
              (s.releaseName ? '<span class="story-release-tag">' + esc(s.releaseName) + '</span>' : '') + '</div>' +
            branchHtml(s) +
            prInfoHtml(s) +
          '</div>' +
          '<div class="story-actions">' + actions + '</div>' +
        '</div>';
      }).join('');

      const n = comp.excludeStories.length;
      const anyNoPr = comp.excludeStories.some(s => !prsOf(s).length);
      const risk = n >= 2 && anyNoPr ? 'high' : (n >= 2 || anyNoPr ? 'med' : 'low');
      const riskTip = { high: 'Several stories, at least one without a PR', med: 'Several stories, or a story without a PR', low: 'One story with a PR' }[risk];
      return '<div class="component-item">' +
        '<div class="component-header" onclick="toggleComponent(' + idx + ')">' +
          '<span class="component-chevron" id="chevron-' + idx + '"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span>' +
          '<span class="component-name">' + esc(comp.name) + '</span>' +
          '<span class="component-type">' + esc(comp.type) + '</span>' +
          '<span class="component-count">' + n + ' stor' + (n === 1 ? 'y' : 'ies') + '</span>' +
          '<span class="risk risk-' + risk + '" title="' + riskTip + '"></span>' +
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
      case 'prefsSaved':
        SAVED = msg.prefs;
        refreshPrefsState();
        break;
      case 'releases': {
        _orgInstanceUrl = msg.orgInstanceUrl || '';
        document.getElementById('modeCard').style.display = 'block';
        document.getElementById('orgDot').classList.add('on');
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
        _last = { components: msg.components, mode: msg.mode };
        renderEnvOptions(msg.components);
        refreshPrefsState();
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
      case 'notice':
        showStatus(msg.message, msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'success', false);
        scrollToStatus();
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

  applyTheme(currentTheme);
  renderEnvOptions([]);
  setPrSource(_prSource);
  if (SAVED.mode === 'story') switchMode('story');
  refreshPrefsState();
  document.querySelector('.theme-toggle').addEventListener('click', e => {
    const b = e.target.closest('[data-theme-btn]');
    if (!b) return;
    applyTheme(b.dataset.themeBtn);
    vscode.setState(Object.assign({}, vscode.getState() || {}, { theme: b.dataset.themeBtn }));
    refreshPrefsState();
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
