import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitContentProvider } from '../extension';

// ─── Debug log ────────────────────────────────────────────────────────────────

let _out: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!_out) _out = vscode.window.createOutputChannel('Release Overlap Inspector');
  _out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SfRecord { [key: string]: string }

interface SavedPrefs {
  prSource?: 'feature' | 'promo';
  mode?: 'release' | 'story';
  theme?: 'auto' | 'light' | 'dark';
  promoEnv?: string;         // '' = the story's next environment
  compareBy?: 'release' | 'env';
  envName?: string;          // Copado environment the bundle is taken from
  pipeline?: string;         // Copado pipeline name whose environments are offered
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
  movedBack?: { now: string; env: string; promotion: string; deployedAt: string };
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
    const r = readBlob(ref, filePath, repoPath);
    if (r !== null) return r;
  }
  return ''; // file not found in either ref — treat as empty (new file in that branch)
}

// cat-file, not show: on Windows `git show <40-char sha>^:<path>` first stats the whole argument as a file,
// which fails past MAX_PATH inside the deep clone folder, so show exits 128 and the left side came out empty.
// The 64 MB buffer is for large permission sets/profiles (spawnSync's 1 MB default fails silently).
function readBlob(ref: string, filePath: string, repoPath: string): string | null {
  const r = spawnSync('git', ['cat-file', 'blob', `${ref}:${filePath}`], {
    cwd: repoPath, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

// GitHub account per repo folder. With several accounts stored, Git Credential Manager otherwise asks which
// one to use on every fetch; an entry also means fetches must never prompt ('' = no account has access).
const gitAccounts = new Map<string, string>();
const QUIET_GIT_ENV = { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };
const netArgs = (repoPath: string, args: string[]): string[] => {
  const user = gitAccounts.get(repoPath);
  return user ? ['-c', `credential.username=${user}`, ...args] : args;
};
const netEnv = (repoPath: string): NodeJS.ProcessEnv | undefined => gitAccounts.has(repoPath) ? QUIET_GIT_ENV : undefined;

function gitFetchBranch(branch: string, repoPath: string): void {
  spawnSync('git', netArgs(repoPath, ['fetch', 'origin', branch]), {
    cwd: repoPath, encoding: 'utf8', shell: false, env: netEnv(repoPath),
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
  return readBlob(ref, filePath, repoPath) ?? '';
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

// Non-blocking git for work that runs many commands (PR checks, fetches), capped so a component
// with many stories doesn't start dozens of git processes at once.
const MAX_PARALLEL_GIT = 6;
let gitActive = 0;
const gitWaiters: Array<() => void> = [];

const gitChildren = new Set<ReturnType<typeof spawn>>();
let gitStopped = false;

// Closing the panel must not leave fetches running (each one can raise a credential prompt).
function stopAllGit(): void {
  gitStopped = true;
  for (const p of gitChildren) {
    if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill();
  }
  gitChildren.clear();
  gitWaiters.splice(0).forEach(r => r());
}

async function gitAsync(args: string[], repoPath: string, input?: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; code: number; out: string; err: string }> {
  while (gitActive >= MAX_PARALLEL_GIT && !gitStopped) await new Promise<void>(r => gitWaiters.push(r));
  if (gitStopped) return { ok: false, code: -1, out: '', err: 'stopped' };
  gitActive++;
  try {
    return await new Promise(resolve => {
      const p = spawn('git', args, { cwd: repoPath, shell: false, env, windowsHide: true });
      gitChildren.add(p);
      let out = '';
      let err = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d: string) => { out += d; });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (d: string) => { if (err.length < 4000) err += d; });
      p.stdin.on('error', () => { /* git exited before reading all input */ });
      p.on('error', () => { gitChildren.delete(p); resolve({ ok: false, code: -1, out: '', err: 'spawn failed' }); });
      p.on('close', code => { gitChildren.delete(p); resolve({ ok: code === 0, code: code ?? -1, out, err }); });
      p.stdin.end(input ?? '');
    });
  } finally {
    gitActive--;
    gitWaiters.shift()?.();
  }
}

// Picks the GitHub account for a repo folder without any prompt: the user in the remote URL if set, else
// the remembered one if it still works, else the first stored account that can read the repo.
// null = leave git alone (zero or one stored account, so Git Credential Manager has nothing to ask).
async function chooseGitAccount(repoPath: string, remembered: string): Promise<string | null> {
  const origin = (await gitAsync(['remote', 'get-url', 'origin'], repoPath)).out.trim();
  const inUrl = origin.match(/^https?:\/\/([^@/:]+)(?::[^@/]*)?@/)?.[1];
  if (inUrl) return decodeURIComponent(inUrl);
  if (!/^https?:\/\//i.test(origin)) return null;
  const listed = (await gitAsync(['credential-manager', 'github', 'list'], repoPath, undefined, QUIET_GIT_ENV)).out
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (listed.length < 2) return null;
  const candidates = [...new Set([remembered, ...listed].filter(u => u && listed.includes(u)))];
  for (const user of candidates) {
    if (gitStopped) return null;
    const r = await gitAsync(['-c', `credential.username=${user}`, 'ls-remote', 'origin', 'HEAD'], repoPath, undefined, QUIET_GIT_ENV);
    if (r.ok) return user;
  }
  return '';
}

const AUTH_FAILURE =/authentication failed|could not read username|terminal prompts disabled|repository not found|returned error: 40[13]|permission denied/i;

const gitRefExistsAsync = async (ref: string, repoPath: string): Promise<boolean> =>
  (await gitAsync(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)).ok;

async function gitFetchRefspecsAsync(refspecs: string[], repoPath: string): Promise<void> {
  if (refspecs.length === 0) return;
  const batch = await gitAsync(netArgs(repoPath, ['fetch', 'origin', ...refspecs]), repoPath, undefined, netEnv(repoPath));
  if (batch.ok || gitStopped) return;
  if (AUTH_FAILURE.test(batch.err)) {
    log(`git fetch failed on credentials, not retrying per ref: ${batch.err.trim().slice(0, 300)}`);
    return;
  }
  // One missing ref (e.g. a deleted base branch) fails the whole batch. Ask GitHub which refs exist and fetch
  // those in one go; refetching ~150 refs one by one at ~2 s each took minutes.
  const srcOf = (spec: string) => spec.replace(/^\+/, '').split(':')[0];
  const listed = await gitAsync(netArgs(repoPath, ['ls-remote', 'origin', ...new Set(refspecs.map(srcOf))]), repoPath, undefined, netEnv(repoPath));
  if (gitStopped) return;
  if (listed.ok) {
    const existing = new Set(listed.out.split('\n').map(l => l.split('\t')[1]?.trim()).filter(Boolean));
    const present = refspecs.filter(s => existing.has(srcOf(s)));
    log(`git fetch: ${refspecs.length - present.length} ref(s) no longer on the remote: ${refspecs.filter(s => !existing.has(srcOf(s))).map(srcOf).join(', ').slice(0, 300)}`);
    if (present.length === 0) return;
    if ((await gitAsync(netArgs(repoPath, ['fetch', 'origin', ...present]), repoPath, undefined, netEnv(repoPath))).ok || gitStopped) return;
  }
  for (const spec of refspecs) {
    if (gitStopped) return;
    await gitAsync(netArgs(repoPath, ['fetch', 'origin', spec]), repoPath, undefined, netEnv(repoPath));
  }
}

type StoryCommits = { commits: string[]; note?: string } | { error: string };

// What a branch had before the PR head reached it. Excluding the branch as it is now would also drop the
// story's own commits once they are promoted into it (e.g. a feature PR whose story is now in master).
async function excludeBranch(ref: string, head: string, repoPath: string): Promise<string | null> {
  if (!await gitRefExistsAsync(ref, repoPath)) return null;
  if (!(await gitAsync(['merge-base', '--is-ancestor', head, ref], repoPath)).ok) return `^${ref}`;
  // Copado lands PRs through promotion-branch merges, so find the oldest merge that brought the head in.
  const merges = (await gitAsync(['log', ref, '--ancestry-path', '--merges', '--format=%H', `${head}..${ref}`], repoPath))
    .out.trim().split('\n').filter(Boolean);
  const landing = merges[merges.length - 1];
  return landing ? `^${landing}^1` : null;
}

// The story's own commits in a PR: reachable from the PR head, minus what the story's base branch and the
// PR's target branch had before the PR's commits reached them.
async function prStoryCommits(pr: PullRequest, baseBranch: string, repoPath: string): Promise<StoryCommits> {
  const head = (await gitAsync(['rev-parse', '--verify', '--quiet', `refs/remotes/pr/${pr.number}^{commit}`], repoPath)).out.trim();
  if (!head) return { error: 'PR head could not be fetched from GitHub' };

  const refs = [...new Set([`origin/${baseBranch}`, pr.targetBranch ? `origin/${pr.targetBranch}` : ''].filter(r => r !== 'origin/' && r))];
  const exclude = [...new Set((await Promise.all(refs.map(ref => excludeBranch(ref, head, repoPath)))).filter((e): e is string => !!e))];

  const r = await gitAsync(['rev-list', '--no-merges', head, ...exclude], repoPath);
  if (!r.ok) return { error: 'could not list PR commits' };
  log(`PR #${pr.number} head ${head.slice(0, 10)} excl [${exclude.join(' ')}] → ${r.out.trim().split('\n').filter(Boolean).length} commit(s)`);
  return { commits: r.out.trim().split('\n').filter(Boolean) };
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// In a promotion PR, the story arrives through Copado's "Merging feature/<story> to promotion/<P>" commit;
// only that merge counts, so other stories in the same promotion stay out of the diff.
async function promoStoryCommits(pr: PullRequest, storyName: string, baseBranch: string, repoPath: string): Promise<StoryCommits> {
  const head = (await gitAsync(['rev-parse', '--verify', '--quiet', `refs/remotes/pr/${pr.number}^{commit}`], repoPath)).out.trim();
  if (!head) return { error: 'PR head could not be fetched from GitHub' };
  const promo = pr.promotion ?? '';
  const pattern = `Merging feature/${reEscape(storyName)} to promotion/${reEscape(promo)}([^0-9A-Za-z]|$)`;
  const found = (await gitAsync(['log', head, '-i', '-E', `--grep=${pattern}`, '--format=%H %P'], repoPath))
    .out.trim().split('\n').filter(Boolean).map(l => l.split(' '));
  const merges = found.filter(parts => parts.length > 2).map(parts => parts[0]);
  if (merges.length) {
    log(`PR #${pr.number} (${promo}) merge commit(s) for ${storyName}: ${merges.map(m => m.slice(0, 10)).join(', ')}`);
    return { commits: merges };
  }

  // No true merge (fast-forward or a different message): fall back to the story's own commits in the PR.
  const res = await prStoryCommits(pr, baseBranch, repoPath);
  if ('error' in res) return res;
  const nameRe = new RegExp(`^(${reEscape(storyName)}\\b|Merging feature/${reEscape(storyName)}\\b)`, 'i');
  const commits = (await gitAsync(['log', '--no-walk', '--stdin', '--format=%H %s'], repoPath, res.commits.join('\n') + '\n'))
    .out.trim().split('\n').filter(Boolean)
    .filter(l => nameRe.test(l.slice(l.indexOf(' ') + 1)))
    .map(l => l.split(' ')[0]);
  if (commits.length === 0) return { error: `no merge of ${storyName} into promotion/${promo} found in the PR` };
  return { commits, note: `#${pr.number}: no merge commit for ${storyName} found, used commits named after the story` };
}

// Bundles are a folder of files, so a PR that only edits the LWC's HTML still counts as changing it.
function touchPath(name: string, type: string): string {
  if (type === 'LightningComponentBundle') return `force-app/main/default/lwc/${name}/`;
  if (type === 'AuraDefinitionBundle') return `force-app/main/default/aura/${name}/`;
  return getFilePath(name, type);
}

// Whether the given story commits change a path. Promotion merges are judged against their first parent
// (what the merge brought in); git log's path filter can't be used for them. Unknown counts as a change.
async function commitsTouch(commits: string[], filePath: string, source: 'feature' | 'promo', repoPath: string): Promise<boolean> {
  if (commits.length === 0) return false;
  if (source === 'feature') {
    const r = await gitAsync(['log', '--no-walk', '--stdin', '--format=%H', '--', filePath], repoPath, commits.join('\n') + '\n');
    return !r.ok || r.out.trim().length > 0;
  }
  for (const c of commits) {
    if ((await gitAsync(['diff', '--quiet', `${c}^1`, c, '--', filePath], repoPath)).code !== 0) return true;
  }
  return false;
}

// Every file the story commits change, so any number of components can be checked without more git calls.
// null = could not be read.
async function commitsFiles(commits: string[], source: 'feature' | 'promo', repoPath: string): Promise<Set<string> | null> {
  const files = new Set<string>();
  if (commits.length === 0) return files;
  const add = (out: string) => out.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => files.add(f));
  if (source === 'feature') {
    const r = await gitAsync(['-c', 'core.quotepath=off', 'log', '--no-walk', '--stdin', '--name-only', '--no-renames', '--diff-merges=dense-combined', '--format='], repoPath, commits.join('\n') + '\n');
    if (!r.ok) return null;
    add(r.out);
    return files;
  }
  for (const c of commits) {
    const r = await gitAsync(['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${c}^1`, c], repoPath);
    if (!r.ok) return null;
    add(r.out);
  }
  return files;
}

type TouchStory = { id: string; name: string; repoUrl: string; baseBranch: string; prs: PullRequest[] };
type TouchJob = { key: string; componentName: string; componentType: string; stories: TouchStory[] };

const touchesPath = (files: Set<string>, filePath: string): boolean =>
  filePath.endsWith('/') ? [...files].some(f => f.startsWith(filePath)) : files.has(filePath);

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
      ? git(['cat-file', 'blob', `:${filePath}`], repoPath, { env }).out
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

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

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
  return parseQueryOutput(r.stdout, r.stderr, r.status);
}

function parseQueryOutput(stdout: string, stderr: string, status: number | null): SfRecord[] {
  // With --json, sf always writes the response as JSON to stdout even when it
  // exits non-zero due to unrelated warnings (ESM plugin, update notices in stderr).
  // Parse stdout first; only treat it as an error if the JSON itself says so.
  try {
    const parsed = JSON.parse(stdout) as { status?: number; result?: { records?: SfRecord[] }; message?: string };
    if (parsed?.result?.records !== undefined) return parsed.result.records;
    if (parsed?.message) throw new Error(parsed.message);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  throw new Error(stderr || stdout || `SF query failed (exit ${status})`);
}

// Same as queryOrg but does not block the extension host, so several can run side by side.
function queryOrgAsync(soql: string, orgAlias: string): Promise<SfRecord[]> {
  const sfArgs = ['data', 'query', '--query', soql, '--target-org', orgAlias, '--json'];
  const [exe, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'sf', ...sfArgs]] as const
    : ['sf', sfArgs] as const;
  log(`Spawn (async): ${exe} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { shell: false, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    const timer = setTimeout(() => {
      // Killing cmd.exe alone would leave the sf node process running.
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
      reject(new Error('SF query timed out after 60 seconds'));
    }, 60_000);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Failed to launch sf: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      log(`Exit (async): ${code ?? 'null'} | stdout: ${out.slice(0, 300)} | stderr: ${err.slice(0, 200)}`);
      try { resolve(parseQueryOutput(out, err, code)); } catch (e) { reject(e); }
    });
  });
}

// More would add little speed and each sf process takes ~200 MB on the VDI.
const MAX_PARALLEL_QUERIES = 4;

type Report = (done: number, total: number) => void;

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
      'Release Overlap Inspector',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    ReleaseCheckerPanel.currentPanel = new ReleaseCheckerPanel(panel, extensionUri);
  }

  private readonly logoUri: string;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    gitStopped = false;
    this.logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon.png')).toString();
    // Pre-fill: saved alias first, fall back to sf config default org
    const saved    = ReleaseCheckerPanel.context?.globalState.get<string>('lastOrgAlias') ?? '';
    const detected = saved || getDefaultSfOrg();
    this.orgAlias  = detected;
    const prefs = ReleaseCheckerPanel.context?.globalState.get<SavedPrefs>('savedPrefs') ?? {};
    this.panel.webview.html = this.getHtml(detected, prefs, this.orgHistory());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => void this.handleMessage(msg),
      null,
      this.disposables
    );
    this.loadCliAliases();
  }

  // Org aliases connected to successfully, most recent first; offered as suggestions in the org box.
  private orgHistory(): string[] {
    return ReleaseCheckerPanel.context?.globalState.get<string[]>('orgHistory') ?? [];
  }

  // The sf CLI's own aliases (authorised orgs) come after the ones used here, so an org never connected to yet is still offered.
  private cliAliases: string[] = [];

  private postOrgSuggestions(): void {
    const seen = new Set<string>();
    const orgs = [...this.orgHistory(), ...this.cliAliases].filter(a => {
      const k = a.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.post({ type: 'orgHistory', orgs });
  }

  private rememberOrg(alias: string): void {
    const list = [alias, ...this.orgHistory().filter(a => a.toLowerCase() !== alias.toLowerCase())].slice(0, 20);
    void ReleaseCheckerPanel.context?.globalState.update('orgHistory', list).then(() => this.postOrgSuggestions());
  }

  private loadCliAliases(): void {
    const [exe, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'sf', 'alias', 'list', '--json']] as const
      : ['sf', ['alias', 'list', '--json']] as const;
    const child = spawn(exe, args, { shell: false });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => { /* sf not available: history only */ });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out) as { result?: Array<{ alias?: string }> };
        this.cliAliases = (parsed.result ?? []).map(r => r.alias ?? '').filter(Boolean).sort((a, b) => a.localeCompare(b));
        this.postOrgSuggestions();
      } catch { /* ignore */ }
    });
  }

  private post(data: Record<string, unknown>): Thenable<boolean> {
    return this.panel.webview.postMessage(data);
  }

  private activeQueries = 0;
  private queryWaiters: Array<() => void> = [];
  private warm = false;

  // Runs at most MAX_PARALLEL_QUERIES at once; until one has succeeded in this run they go one by one,
  // so an expired login token is refreshed by a single sf process rather than several racing.
  private async query(soql: string): Promise<SfRecord[]> {
    while (this.activeQueries >= (this.warm ? MAX_PARALLEL_QUERIES : 1)) {
      await new Promise<void>(r => this.queryWaiters.push(r));
    }
    this.activeQueries++;
    try {
      const records = await queryOrgAsync(soql, this.orgAlias);
      this.warm = true;
      return records;
    } finally {
      this.activeQueries--;
      this.queryWaiters.splice(0).forEach(r => r());
    }
  }

  // Each call starts the next step; the returned reporter posts real done/total counts for it.
  private stepper(steps: number): (label: string, unit: 'story' | 'release' | 'query') => Report {
    let n = 0;
    return (label, unit) => {
      const step = ++n;
      return (done, total) => { void this.post({ type: 'progress', step, steps, label, unit, done, total }); };
    };
  }

  // Runs fn over items in batches (in parallel, within the query limit) and returns results in input order.
  // Progress is reported in items, so a batch of 50 stories moves the count by 50.
  private async inBatches<T, R>(items: T[], size: number, report: Report | undefined, fn: (batch: T[]) => Promise<R>): Promise<R[]> {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
    let done = 0;
    report?.(0, items.length);
    return Promise.all(batches.map(b => fn(b).then(r => {
      done += b.length;
      report?.(done, items.length);
      return r;
    })));
  }

  private async fetchStoriesForReleases(releaseIds: string[], report?: Report): Promise<Story[][]> {
    return this.inBatches(releaseIds, 1, report, ([id]) => this.fetchStoriesForRelease(id));
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
      case 'fetchPipelineEnvs':
        this.fetchPipelineEnvironments(String(msg.pipelineId ?? ''));
        break;
      case 'analyseEnv':
        await this.analyseAgainstEnv(msg.promoteIds as string[], String(msg.envId ?? ''), String(msg.envName ?? ''), String(msg.pipelineId ?? ''));
        break;
      case 'checkPrTouchAll':
        await this.checkPrTouchAll(msg);
        break;
      case 'prTouchFirst':
        this.prioritiseTouch(String(msg.key ?? ''));
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
          msg.source === 'promo' ? 'promo' : 'feature',
          typeof msg.env === 'string' ? msg.env : ''
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
          compareBy: p.compareBy === 'env' ? 'env' : 'release',
          envName: typeof p.envName === 'string' ? p.envName.slice(0, 120) : '',
          pipeline: typeof p.pipeline === 'string' ? p.pipeline.slice(0, 120) : '',
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
      this.rememberOrg(orgAlias);

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

      let pipelines: Array<{ id: string; name: string; active: boolean }> = [];
      try {
        pipelines = queryOrg('SELECT Id, Name, copado__Active__c FROM copado__Deployment_Flow__c ORDER BY Name LIMIT 200', orgAlias)
          .map(r => ({ id: r['Id'], name: r['Name'], active: String(r['copado__Active__c']) === 'true' }));
      } catch (e) {
        log(`Pipeline lookup failed: ${String(e)}`);
      }

      this.post({
        type: 'releases',
        pipelines,
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
    this.resetRunCaches();
    this.warm = false;
    const step = this.stepper(6);
    try {
      const promoteStories = (await this.fetchStoriesForReleases(promoteIds, step('Fetching stories of the releases to promote', 'release'))).flat();
      const promoteMeta = await this.fetchMetadataForStories(promoteStories.map(s => s.id), step(`Fetching components of ${promoteStories.length} stories to promote`, 'story'));

      const futureLists = await this.fetchStoriesForReleases(excludeIds, step('Fetching stories of the future planned releases', 'release'));
      const allFutureStories: Story[] = futureLists.flatMap((list, i) => list.map(s => ({ ...s, releaseName: excludeNames[i] ?? excludeIds[i] })));
      const allFutureMeta = await this.fetchMetadataForStories(allFutureStories.map(s => s.id), step(`Fetching components of ${allFutureStories.length} future-release stories`, 'story'));

      const common = this.findCommonComponents(promoteMeta, allFutureMeta, allFutureStories);
      const involved = common.flatMap(c => c.excludeStories);
      const n = new Set(involved.map(s => s.id)).size;
      const prStep = step(`Fetching pull requests of ${n} future-release stories`, 'story');
      const promoStep = step(`Checking promotions and promotion PRs of ${n} stories`, 'story');
      if (involved.length > 0) {
        await this.attachPullRequests(involved, prStep);
        await this.attachPromotionPullRequests(involved, promoStep);
      }
      this.post({ type: 'results', components: common, mode: 'release', orgInstanceUrl: this.orgInstanceUrl });
    } catch (e) {
      this.post({ type: 'error', message: String(e) });
    }
  }

  private fetchPipelineEnvironments(pipelineId: string): void {
    if (!SF_ID.test(pipelineId)) { this.post({ type: 'pipelineEnvs', pipelineId, environments: [] }); return; }
    try {
      const steps = queryOrg(
        `SELECT copado__Source_Environment__c, copado__Source_Environment__r.Name, copado__Destination_Environment__c, copado__Destination_Environment__r.Name ` +
        `FROM copado__Deployment_Flow_Step__c WHERE copado__Deployment_Flow__c = '${pipelineId}'`,
        this.orgAlias
      );
      const names = new Map<string, string>();
      const next = new Map<string, string>();
      for (const s of steps) {
        const src = val(s, 'copado__Source_Environment__c');
        const dst = val(s, 'copado__Destination_Environment__c');
        if (src) names.set(src, val(s, 'copado__Source_Environment__r.Name') || src);
        if (dst) names.set(dst, val(s, 'copado__Destination_Environment__r.Name') || dst);
        if (src && dst) next.set(src, dst);
      }
      // Hops to the end of the pipeline, so the list reads dev sandboxes first and production last.
      const hops = (id: string): number => {
        const seen = new Set<string>();
        let cur = id;
        while (next.has(cur) && !seen.has(cur)) { seen.add(cur); cur = next.get(cur)!; }
        return seen.size;
      };
      const environments = [...names].map(([id, name]) => ({ id, name, hops: hops(id) }))
        .sort((a, b) => b.hops - a.hops || a.name.localeCompare(b.name))
        .map(({ id, name }) => ({ id, name }));
      this.post({ type: 'pipelineEnvs', pipelineId, environments });
    } catch (e) {
      this.post({ type: 'error', message: `Failed to load the pipeline's environments: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ── Analyse a release against everything else sitting in an environment ────

  private async analyseAgainstEnv(promoteIds: string[], envId: string, envLabel: string, pipelineId: string): Promise<void> {
    try {
      if (!SF_ID.test(envId)) throw new Error('Please pick an environment.');
      const ids = (promoteIds ?? []).filter(id => SF_ID.test(id));
      if (ids.length === 0) throw new Error('No valid release to promote was selected.');
      const envName = envLabel || 'the environment';
      this.resetRunCaches();
      this.warm = false;
      const step = this.stepper(6);

      const promoteStories = (await this.fetchStoriesForReleases(ids, step('Fetching stories of the releases to promote', 'release'))).flat();
      const promoteMeta = await this.fetchMetadataForStories(promoteStories.map(s => s.id), step(`Fetching components of ${promoteStories.length} stories to promote`, 'story'));

      const quoted = (list: string[]) => list.map(id => `'${id}'`).join(',');
      const lookup = step(`Looking up stories sitting in ${envName} or moved back from it`, 'query');
      lookup(0, 3);
      let lookedUp = 0;
      const tick = <T>(p: Promise<T>): Promise<T> => p.then(r => { lookup(++lookedUp, 3); return r; });
      const [current, ownInEnv, movedBack] = await Promise.all([
        tick(this.query(
          `SELECT Id, Name, copado__Base_Branch__c, copado__View_in_Git__c, copado__Release__r.Name FROM copado__User_Story__c ` +
          `WHERE copado__Environment__c = '${envId}' AND (copado__Release__c = null OR copado__Release__c NOT IN (${quoted(ids)}))`
        )),
        tick(this.query(`SELECT Id FROM copado__User_Story__c WHERE copado__Environment__c = '${envId}' AND copado__Release__c IN (${quoted(ids)})`)),
        tick(this.fetchMovedBackStories(envId, envName, pipelineId, ids).catch(e => {
          log(`Stories moved back lookup failed: ${String(e)}`);
          return [] as Story[];
        })),
      ]);
      const currentStories = current.map(r => ({ ...toStory(r), releaseName: val(r, 'copado__Release__r.Name') || 'No release' }));
      const currentIds = new Set(currentStories.map(s => s.id));
      const movedBackStories = movedBack.filter(s => !currentIds.has(s.id));
      const envStories = [...currentStories, ...movedBackStories];
      const envMeta = await this.fetchMetadataForStories(envStories.map(s => s.id), step(`Fetching components of ${envStories.length} stories sitting in ${envName}`, 'story'));

      const common = this.findCommonComponents(promoteMeta, envMeta, envStories);
      const involved = common.flatMap(c => c.excludeStories);
      const n = new Set(involved.map(s => s.id)).size;
      const prStep = step(`Fetching pull requests of ${n} ${envName} stories`, 'story');
      const promoStep = step(`Checking promotions and promotion PRs of ${n} stories`, 'story');
      if (involved.length > 0) {
        await this.attachPullRequests(involved, prStep);
        await this.attachPromotionPullRequests(involved, promoStep);
      }
      this.post({
        type: 'results', components: common, mode: 'env', envName,
        envStoryCount: currentStories.length, envOwnCount: ownInEnv.length, movedBackCount: movedBackStories.length,
        orgInstanceUrl: this.orgInstanceUrl,
      });
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Analyse two user stories directly ──────────────────────────────────────

  private async analyseStories(story1Name: string, story2Name: string): Promise<void> {
    this.post({ type: 'status', message: `Looking up stories ${story1Name} and ${story2Name}…` });
    this.resetRunCaches();
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
      this.warm = true;
      const [meta1, meta2] = await Promise.all([this.fetchMetadataForStories([stories[0].id]), this.fetchMetadataForStories([stories[1].id])]);

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
        await this.attachPullRequests(stories);
        this.post({ type: 'status', message: 'Checking promotions and promotion pull requests…' });
        await this.attachPromotionPullRequests(stories);
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
  // A clone creates .git before it finishes, so a second caller mid-clone must wait on the same job.
  private repoJobs = new Map<string, Promise<string>>();

  private resolveRepoPath(repoUrl: string): Promise<string> {
    const wanted = normaliseRepoUrl(repoUrl);
    let job = this.repoJobs.get(wanted);
    if (!job) {
      job = this.locateRepo(repoUrl, wanted).then(dir => this.pickAccount(dir));
      job.catch(() => this.repoJobs.delete(wanted));
      this.repoJobs.set(wanted, job);
    }
    return job;
  }

  private async pickAccount(dir: string): Promise<string> {
    if (gitAccounts.has(dir)) return dir;
    const store = ReleaseCheckerPanel.context?.globalState;
    const saved = store?.get<Record<string, string>>('gitAccounts') ?? {};
    const user = await chooseGitAccount(dir, saved[dir] ?? '');
    if (user === null) return dir;
    gitAccounts.set(dir, user);
    if (user) {
      log(`Using GitHub account ${user} for ${dir}`);
      if (saved[dir] !== user) void store?.update('gitAccounts', { ...saved, [dir]: user });
    } else {
      log(`No stored GitHub account can read the repo in ${dir}; fetches will not prompt and PRs show as not checked`);
      this.post({ type: 'notice', level: 'warn', message: 'None of your GitHub accounts could read this repo, so PRs could not be fetched. Check your access in GitHub.' });
    }
    return dir;
  }

  private async locateRepo(repoUrl: string, wanted: string): Promise<string> {
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
      throw new Error(`Could not clone ${repoUrl}. Check you have access to it in GitHub (see "Release Overlap Inspector" output for details).`);
    }
    return dir;
  }

  // Per analysis run: refs already fetched and each PR's story commits, so selecting components or
  // opening diffs repeatedly does no repeated GitHub or git work.
  private fetched = new Map<string, Promise<void>>();
  private commitCache = new Map<string, Promise<StoryCommits>>();
  private filesCache = new Map<string, Promise<Set<string> | null>>();

  private resetRunCaches(): void {
    this.fetched.clear();
    this.commitCache.clear();
    this.filesCache.clear();
  }

  private async ensureFetched(repoPath: string, baseBranches: string[] | string, prs: PullRequest[]): Promise<void> {
    const branches = new Set([...(Array.isArray(baseBranches) ? baseBranches : [baseBranches]), ...prs.map(p => p.targetBranch)].filter(Boolean));
    const specs = [
      ...[...branches].map(b => `+refs/heads/${b}:refs/remotes/origin/${b}`),
      ...prs.map(p => `+refs/pull/${p.number}/head:refs/remotes/pr/${p.number}`),
    ];
    const missing = [...new Set(specs)].filter(s => !this.fetched.has(`${repoPath}|${s}`));
    if (missing.length) {
      const job = gitFetchRefspecsAsync(missing, repoPath);
      missing.forEach(s => this.fetched.set(`${repoPath}|${s}`, job));
    }
    await Promise.all(specs.map(s => this.fetched.get(`${repoPath}|${s}`)));
  }

  private storyCommits(pr: PullRequest, storyName: string, baseBranch: string, source: 'feature' | 'promo', repoPath: string): Promise<StoryCommits> {
    const key = [source, repoPath, storyName, baseBranch, pr.number, pr.promotion ?? '', pr.targetBranch].join('|');
    let job = this.commitCache.get(key);
    if (!job) {
      job = source === 'promo' ? promoStoryCommits(pr, storyName, baseBranch, repoPath) : prStoryCommits(pr, baseBranch, repoPath);
      this.commitCache.set(key, job);
    }
    return job;
  }

  // Each job carries its own batch's source, run and repos, since jobs from an earlier batch stay queued.
  private touchQueue: Array<TouchJob & { source: 'feature' | 'promo'; run: unknown; repos: Map<string, Promise<string>> }> = [];

  private prioritiseTouch(key: string): void {
    const i = this.touchQueue.findIndex(j => j.key === key);
    if (i > 0) this.touchQueue.unshift(...this.touchQueue.splice(i, 1));
  }

  // Files changed by one PR's story commits; computed once per run, then every component is a set lookup.
  private prFiles(pr: PullRequest, storyName: string, baseBranch: string, source: 'feature' | 'promo', repoPath: string): Promise<Set<string> | null> {
    const key = [source, repoPath, storyName, baseBranch, pr.number, pr.promotion ?? '', pr.targetBranch].join('|');
    let job = this.filesCache.get(key);
    if (!job) {
      job = this.storyCommits(pr, storyName, baseBranch, source, repoPath).then(res =>
        // A fallback to plain story commits (no promotion merge found) is judged like a feature PR.
        'error' in res ? null : commitsFiles(res.commits, res.note ? 'feature' : source, repoPath));
      this.filesCache.set(key, job);
    }
    return job;
  }

  // Which of each story's PRs change each component, for every component of the results at once. One fetch
  // covers all PRs; results go back per component as they are ready, in the order sent (selected first).
  // A PR whose commits can't be read stays "unknown" so it is still offered; clicking it gives the reason.
  private async checkPrTouchAll(msg: Record<string, unknown>): Promise<void> {
    const source: 'feature' | 'promo' = msg.source === 'promo' ? 'promo' : 'feature';
    const jobs = (msg.jobs as TouchJob[]) ?? [];
    const run = msg.run;
    const started = Date.now();
    const repoOf = (s: TouchStory) => s.repoUrl || repoUrlFrom(s.prs.find(p => p.url)?.url ?? '');

    // Resolve and fetch each repo once for the whole batch.
    const repos = new Map<string, Promise<string>>();
    const byRepo = new Map<string, TouchStory[]>();
    for (const s of jobs.flatMap(j => j.stories)) byRepo.set(repoOf(s), [...(byRepo.get(repoOf(s)) ?? []), s]);
    for (const [repo, list] of byRepo) {
      repos.set(repo, (async () => {
        let repoPath = '';
        try { repoPath = await this.resolveRepoPath(repo); } catch (e) { log(`PR check: ${String(e)}`); return ''; }
        const prs = new Map<number, PullRequest>();
        list.forEach(s => splitByRepo(repo, s.prs).prs.forEach(p => prs.set(p.number, p)));
        await this.ensureFetched(repoPath, [...new Set(list.map(s => s.baseBranch))], [...prs.values()]);
        return repoPath;
      })());
    }

    // A component the user opens while the batch runs jumps the queue (see 'prTouchFirst'). The jobs of an
    // earlier batch that hasn't finished stay queued behind this one, so their rows never stay on "checking…".
    const queue = [...jobs.map(j => ({ ...j, source, run, repos })), ...this.touchQueue];
    this.touchQueue = queue;
    while (queue.length) {
      if (gitStopped || this.touchQueue !== queue) return;
      const job = queue.shift()!;
      const results: Record<string, { touching: number[]; unknown: number[] }> = {};
      try {
        const filePath = touchPath(job.componentName, job.componentType);
        await Promise.all(job.stories.map(async s => {
          const repo = repoOf(s);
          const split = splitByRepo(repo, s.prs);
          const r = results[s.id] = { touching: [] as number[], unknown: s.prs.filter(p => !split.prs.includes(p)).map(p => p.number) };
          const repoPath = await job.repos.get(repo);
          await Promise.all(split.prs.map(async pr => {
            const files = repoPath ? await this.prFiles(pr, s.name, s.baseBranch, job.source, repoPath) : null;
            if (!files) r.unknown.push(pr.number);
            else if (touchesPath(files, filePath)) r.touching.push(pr.number);
          }));
        }));
      } catch (e) {
        // Without a reply the rows would stay on "checking…"; an empty result offers every PR.
        log(`PR check failed for ${job.componentType} ${job.componentName}: ${String(e)}`);
      }
      this.post({ type: 'prTouch', key: job.key, run: job.run, results });
    }
    log(`PR check (${source}) of ${jobs.length} components in ${Date.now() - started} ms`);
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
    source: 'feature' | 'promo' = 'feature',
    env = ''
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
    await this.ensureFetched(repoPath, baseBranch, prs);

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
      const res = await this.storyCommits(pr, storyName, baseBranch, source, repoPath);
      if ('error' in res) { failed.push(`#${pr.number}: ${res.error}`); continue; }
      if (res.note) { warnings.push(res.note); usedMerges = false; }
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
      const bundle = touchPath(componentName, componentType);
      const otherFiles = bundle !== filePath && await commitsTouch([...commits], bundle, usedMerges ? 'promo' : 'feature', repoPath);
      const msg = otherFiles
        ? `${prLabel} change${prs.length === 1 ? 's' : ''} other files of the ${componentName} bundle (${bundle}), but not ${filePath.split('/').pop()}, which is the file the diff shows.`
        : `${prLabel} (${commits.size} ${unit}${commits.size === 1 ? '' : 's'}) do${prs.length === 1 ? 'es' : ''} not change ${componentName} (${componentType}) — checked ${filePath}.`;
      this.post({ type: 'notice', level: 'info', message: msg + (warnings.length ? ` Note: ${warnings.join('; ')}.` : '') });
      return;
    }
    if (!d.exact) warnings.push('the commits did not replay cleanly, so the right side is the file at the newest story commit');

    const prIds = prs.map(p => p.number).sort((a, b) => a - b).join('-');
    const key = `${source}/${encodeURIComponent(env || '-')}/${encodeURIComponent(storyName)}/${prIds}/${encodeURIComponent(componentName)}`;
    const leftUri  = vscode.Uri.parse(`sfconflict:pr-before/${key}`);
    const rightUri = vscode.Uri.parse(`sfconflict:pr-after/${key}`);
    ReleaseCheckerPanel.gitProvider.set(leftUri.toString(), d.left);
    ReleaseCheckerPanel.gitProvider.set(rightUri.toString(), d.right);

    const title = `${storyName} → ${componentName}  (${source === 'promo' ? (env ? env + ' · ' : '') + 'Promotion ' : ''}PR ${prLabel} · ${d.touching.length} ${unit}${d.touching.length === 1 ? '' : 's'})`;
    await this.showDiff(leftUri, rightUri, title);
    log(`PR diff ${storyName} ${componentName}: commits touching file = ${d.touching.map(c => c.slice(0, 10)).join(', ')}`);
    this.post(warnings.length
      ? { type: 'notice', level: 'warn', message: `Diff opened: ${componentName}. Note: ${warnings.join('; ')}.` }
      : { type: 'status', message: `Diff opened: ${componentName} (${d.touching.map(c => c.slice(0, 7)).join(', ')})`, spinner: false });
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async fetchStoriesForRelease(releaseId: string): Promise<Story[]> {
    const records = await this.query(
      `SELECT Id, Name, copado__Base_Branch__c, copado__View_in_Git__c FROM copado__User_Story__c WHERE copado__Release__c = '${releaseId}'`
    );
    return records.map(toStory);
  }

  // Mutates the stories in place so every component row sharing a story sees the same PR list.
  private async attachPullRequests(stories: Story[], report?: Report): Promise<void> {
    const unique = [...new Map(stories.map(s => [s.id, s])).values()];
    await this.inBatches(unique, 50, report, async batch => {
      try {
        const records = await this.query(
          `SELECT copado__User_Story__c, copado__Request_Number__c, copado__State__c, copado__Merged__c, copado__Target_Branch__c, copado__Url__c FROM copado__Pull_Request__c WHERE copado__User_Story__c IN (${batch.map(s => `'${s.id}'`).join(',')}) ORDER BY copado__Request_Number__c`
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
    });
  }

  // A promotion qualifies when its latest SFDX Promote and latest SFDX Deploy job executions both succeeded.
  // deployedAt is when that successful deploy ran.
  private async qualifyPromotions(promoIds: string[]): Promise<{ qualified: Map<string, string>; jobState: Map<string, string> }> {
    const qualified = new Map<string, string>();
    const jobState = new Map<string, string>();
    const chunks: string[][] = [];
    for (let j = 0; j < promoIds.length; j += 100) chunks.push(promoIds.slice(j, j + 100));
    await Promise.all(chunks.map(async chunk => {
      const ids = chunk.map(id => `'${id}'`).join(',');
      // SFDX Promote jobs point at the promotion; SFDX Deploy jobs point at the promotion's Deployment record.
      const jobs = await this.query(
        `SELECT copado__Promotion__c, copado__Deployment__r.copado__Promotion__c, copado__Status__c, copado__Template__r.Name, copado__Template__r.copado__ApiName__c, CreatedDate FROM copado__JobExecution__c WHERE copado__Promotion__c IN (${ids}) OR copado__Deployment__r.copado__Promotion__c IN (${ids}) ORDER BY CreatedDate DESC`
      );
      const latest = new Map<string, { promote?: string; deploy?: string; deployedAt?: string }>();
      for (const r of jobs) {
        const id = val(r, 'copado__Promotion__c') || val(r, 'copado__Deployment__r.copado__Promotion__c');
        const name = val(r, 'copado__Template__r.Name');
        const api = val(r, 'copado__Template__r.copado__ApiName__c');
        const entry = latest.get(id) ?? {};
        if (entry.promote === undefined && isTemplate(name, api, 'promote')) entry.promote = val(r, 'copado__Status__c');
        if (entry.deploy === undefined && isTemplate(name, api, 'deploy')) { entry.deploy = val(r, 'copado__Status__c'); entry.deployedAt = val(r, 'CreatedDate'); }
        latest.set(id, entry);
      }
      for (const [id, e] of latest) {
        const state = `latest SFDX Promote: ${e.promote ?? 'none'}, latest SFDX Deploy: ${e.deploy ?? 'none'}`;
        log(`Promotion ${id}: ${state}`);
        jobState.set(id, state);
        if (e.promote === 'Successful' && e.deploy === 'Successful') qualified.set(id, e.deployedAt ?? '');
      }
    }));
    return { qualified, jobState };
  }

  // Stories that were deployed into the environment by a qualifying forward promotion but have since been
  // moved back to an earlier stage (e.g. UAT → DEV): their changes are still in the environment's org.
  // Stories that moved on past the environment are left out.
  private async fetchMovedBackStories(envId: string, envName: string, pipelineId: string, releaseIds: string[]): Promise<Story[]> {
    if (!SF_ID.test(pipelineId)) { log('No pipeline id, so stories moved back were not looked up'); return []; }
    const steps = await this.query(
      `SELECT copado__Source_Environment__c, copado__Destination_Environment__c FROM copado__Deployment_Flow_Step__c WHERE copado__Deployment_Flow__c = '${pipelineId}'`
    );
    const next = new Map<string, string>();
    for (const s of steps) {
      const src = val(s, 'copado__Source_Environment__c');
      const dst = val(s, 'copado__Destination_Environment__c');
      if (src && dst) next.set(src, dst);
    }
    const reachesEnv = (id: string): boolean => {
      const seen = new Set<string>();
      for (let cur = next.get(id); cur && !seen.has(cur); cur = next.get(cur)) {
        if (cur === envId) return true;
        seen.add(cur);
      }
      return false;
    };
    const upstream = [...next.keys()].filter(id => id !== envId && reachesEnv(id));
    if (upstream.length === 0) return [];

    const quoted = (list: string[]) => list.map(id => `'${id}'`).join(',');
    const links = await this.query(
      `SELECT copado__Promotion__c, copado__Promotion__r.Name, copado__User_Story__c, copado__User_Story__r.Name, copado__User_Story__r.copado__Base_Branch__c, ` +
      `copado__User_Story__r.copado__View_in_Git__c, copado__User_Story__r.copado__Release__r.Name, copado__User_Story__r.copado__Environment__r.Name ` +
      `FROM copado__Promoted_User_Story__c ` +
      `WHERE copado__Promotion__r.copado__Destination_Environment__c = '${envId}' AND copado__Promotion__r.copado__Status__c = 'Completed' ` +
      `AND copado__Promotion__r.copado__Back_Promotion__c = false AND copado__User_Story__r.copado__Environment__c IN (${quoted(upstream)}) ` +
      `AND (copado__User_Story__r.copado__Release__c = null OR copado__User_Story__r.copado__Release__c NOT IN (${quoted(releaseIds)}))`
    );
    if (links.length === 0) return [];

    const { qualified } = await this.qualifyPromotions([...new Set(links.map(r => val(r, 'copado__Promotion__c')))]);
    const byStory = new Map<string, Story>();
    for (const r of links) {
      const promoId = val(r, 'copado__Promotion__c');
      if (!qualified.has(promoId)) continue;
      const deployedAt = qualified.get(promoId) ?? '';
      const id = val(r, 'copado__User_Story__c');
      const prev = byStory.get(id);
      if (prev && (prev.movedBack?.deployedAt ?? '') >= deployedAt) continue;
      const story = toStory({
        Id: id,
        Name: val(r, 'copado__User_Story__r.Name'),
        copado__Base_Branch__c: val(r, 'copado__User_Story__r.copado__Base_Branch__c'),
        copado__View_in_Git__c: val(r, 'copado__User_Story__r.copado__View_in_Git__c'),
      });
      story.releaseName = val(r, 'copado__User_Story__r.copado__Release__r.Name') || 'No release';
      story.movedBack = { now: val(r, 'copado__User_Story__r.copado__Environment__r.Name') || 'an earlier environment', env: envName, promotion: val(r, 'copado__Promotion__r.Name'), deployedAt };
      byStory.set(id, story);
    }
    log(`Stories moved back from ${envName}: ${[...byStory.values()].map(s => `${s.name} (now ${s.movedBack!.now}, ${s.movedBack!.promotion})`).join(', ') || 'none'}`);
    return [...byStory.values()];
  }

  // Promotion PRs: for teams that raise a PR from each promotion branch instead of the feature branch.
  // Results are kept per destination environment so the webview can show the story's next environment
  // (default) or any environment the user picks. A promotion qualifies only when it is Completed and its
  // latest SFDX Promote and latest SFDX Deploy job executions both succeeded.
  private async attachPromotionPullRequests(stories: Story[], report?: Report): Promise<void> {
    const unique = [...new Map(stories.map(s => [s.id, s])).values()];
    await this.inBatches(unique, 50, report, async batch => {
      try {
        const links = await this.query(
          `SELECT copado__User_Story__c, copado__Promotion__c, copado__Promotion__r.Name, copado__Promotion__r.copado__Status__c, copado__Promotion__r.CreatedDate, copado__Promotion__r.copado__Source_Environment__c, copado__Promotion__r.copado__Destination_Environment__c, copado__Promotion__r.copado__Destination_Environment__r.Name FROM copado__Promoted_User_Story__c WHERE copado__User_Story__c IN (${batch.map(s => `'${s.id}'`).join(',')}) AND copado__Promotion__r.copado__Back_Promotion__c = false ORDER BY copado__Promotion__r.CreatedDate`
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
        const { qualified, jobState } = await this.qualifyPromotions(promoIds);

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
          const recs = await this.query(
            `SELECT copado__Promotion__c, copado__Request_Number__c, copado__State__c, copado__Merged__c, copado__Target_Branch__c, copado__Url__c FROM copado__Promotion_Pull_Request__c WHERE copado__Promotion__c IN (${ids}) ORDER BY copado__Request_Number__c`
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
    });
  }

  private async fetchMetadataForStories(storyIds: string[], report?: Report): Promise<Array<{ name: string; type: string; storyId: string }>> {
    if (storyIds.length === 0) return [];
    // Batch in groups of 50 to avoid query length limits
    const perBatch = await this.inBatches(storyIds, 50, report, async batch => {
      const ids = batch.map(id => `'${id}'`).join(',');
      const records = await this.query(
        `SELECT copado__Metadata_API_Name__c, copado__Type__c, copado__User_Story__c FROM copado__User_Story_Metadata__c WHERE copado__User_Story__c IN (${ids})`
      );
      return records.map(r => ({
        name: r['copado__Metadata_API_Name__c'] ?? '',
        type: r['copado__Type__c'] ?? 'Unknown',
        storyId: r['copado__User_Story__c'] ?? '',
      }));
    });
    return perBatch.flat();
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

  private getHtml(initialOrg = '', prefs: SavedPrefs = {}, orgs: string[] = []): string {
    const safeOrg = initialOrg.replace(/"/g, '&quot;');
    const orgOptions = orgs.map(o => `<option value="${o.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`).join('');
    const savedJson = JSON.stringify(prefs).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Release Overlap Inspector</title>
<style>
  /* Every colour comes from the active VS Code theme, so the panel follows light, dark and high-contrast themes. */
  :root{
    --bg:var(--vscode-editor-background);
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
    --r:4px; --r-sm:2px;
    --glass:var(--card); --glass-line:var(--line); --glass-shadow:none; --glass-blur:none;
    --seg-on:var(--accent); --seg-on-fg:var(--accent-fg);
  }
  /* Panel-only theme override; "auto" leaves the VS Code theme in charge. */
  :root[data-theme="dark"]{color-scheme:dark}
  :root[data-theme="light"]{color-scheme:light}
  /* VS Code's webview host sets scrollbar-color with the editor background as the track, which also disables ::-webkit-scrollbar styling. */
  html, html *{scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--accent) 32%, transparent) transparent}
  /* Ice-glass palettes; high-contrast themes keep the plain VS Code colours above. */
  html[data-theme="light"] body, html:not([data-theme]) body.vscode-light{
    --backdrop:radial-gradient(900px 600px at 0% 100%,#d3eaf8 0,transparent 60%) fixed,radial-gradient(800px 600px at 100% 0%,#dceefa 0,transparent 60%) fixed,linear-gradient(160deg,#f7fbfe,#eaf4fb 55%,#e2f0f9) fixed;
    --bg:#eef6fc; --fg:#14324a; --muted:#4a7392; --line:rgba(47,134,196,.16); --card:rgba(255,255,255,.7);
    --hover:rgba(47,134,196,.07); --sel:#ffffff; --accent:#2f86c4; --accent-fg:#ffffff; --accent-hover:#2574ad;
    --sec:rgba(255,255,255,.85); --sec-fg:#1f5f8f; --sec-hover:#ffffff; --input:rgba(255,255,255,.9); --input-fg:#14324a; --input-line:rgba(47,134,196,.24);
    --focus:#2f86c4; --link:#1f6fae; --badge:rgba(47,134,196,.12); --badge-fg:#1f5f8f; --placeholder:#7896ad;
    --ok:#1f9d63; --warn:#c27c0e; --err:#d6455d; --info:#2f86c4; --promote:#2f86c4; --future:#0f8fa3;
    --pick-promote:#1f9d63; --pick-future:#c27c0e;
    --r:16px; --r-sm:9px; color-scheme:light;
    --glass:rgba(255,255,255,.55); --glass-line:rgba(255,255,255,.95); --glass-shadow:inset 0 1px 0 #fff,0 10px 30px rgba(60,120,170,.10); --glass-blur:blur(20px) saturate(160%);
    --seg-on:#ffffff; --seg-on-fg:#1f5f8f;
  }
  html[data-theme="dark"] body, html:not([data-theme]) body.vscode-dark{
    --backdrop:radial-gradient(900px 600px at 0% 100%,rgba(47,134,196,.22) 0,transparent 60%) fixed,radial-gradient(800px 600px at 100% 0%,rgba(90,169,220,.16) 0,transparent 60%) fixed,linear-gradient(160deg,#0c141d,#0f1b27 55%,#0b1620) fixed;
    --bg:#0e1823; --fg:#dbe8f2; --muted:#8ea7bb; --line:rgba(140,190,230,.14); --card:rgba(255,255,255,.05);
    --hover:rgba(140,190,230,.08); --sel:rgba(140,190,230,.14); --accent:#3b8fd0; --accent-fg:#ffffff; --accent-hover:#4a9cdc;
    --sec:rgba(255,255,255,.07); --sec-fg:#cfe2f1; --sec-hover:rgba(255,255,255,.12); --input:rgba(255,255,255,.06); --input-fg:#dbe8f2; --input-line:rgba(140,190,230,.22);
    --focus:#5aa9dc; --link:#7cc0ec; --badge:rgba(140,190,230,.16); --badge-fg:#cfe2f1; --placeholder:#6f8aa0;
    --ok:#4cc38a; --warn:#e0a63a; --err:#f07186; --info:#5aa9dc; --promote:#5aa9dc; --future:#3cc2d4;
    --pick-promote:#4cc38a; --pick-future:#e0a63a;
    --r:16px; --r-sm:9px; color-scheme:dark;
    --glass:rgba(255,255,255,.045); --glass-line:rgba(255,255,255,.09); --glass-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 10px 30px rgba(0,0,0,.25); --glass-blur:blur(20px) saturate(140%);
    --seg-on:rgba(255,255,255,.13); --seg-on-fg:#ffffff;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);font-size:var(--vscode-font-size, 13px);line-height:1.5;background:var(--backdrop, var(--bg));color:var(--fg)}
  .app{display:grid;grid-template-columns:300px minmax(0,1fr);gap:14px;padding:14px;min-height:100vh}
  .stack > * + *{margin-top:16px}
  .glass{background:var(--glass);border:1px solid var(--glass-line);border-radius:var(--r);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}

  /* ── Side rail ── */
  .rail{padding:16px;position:sticky;top:14px;height:calc(100vh - 28px);overflow-y:auto}
  .brand{font-weight:700;font-size:16px;color:var(--promote)}
  .brand{display:flex;align-items:center;gap:10px}
  .brand-logo{flex-shrink:0;width:34px;height:34px;object-fit:contain}
  .brand small{display:block;font-weight:400;font-size:11px;color:var(--muted);margin-top:2px}
  .lab{display:flex;align-items:baseline;gap:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
  .lab .cnt{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:400;color:var(--link)}
  .org-row{display:flex;gap:6px}
  .org-wrap{position:relative;flex:1;min-width:0}
  .org-dot{position:absolute;left:9px;top:50%;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:var(--muted);opacity:.45}
  .org-dot.on{background:var(--ok);opacity:1}
  input[type=text],input[type=search]{width:100%;background:var(--input);color:var(--input-fg);border:1px solid var(--input-line);border-radius:var(--r-sm);padding:5px 8px;font:inherit;outline:none}
  input[type=text]:focus,input[type=search]:focus{border-color:var(--focus);outline:1px solid var(--focus);outline-offset:-1px}
  select{width:100%;background:var(--input);color:var(--input-fg);border:1px solid var(--input-line);border-radius:var(--r-sm);padding:4px 6px;font:inherit;outline:none}
  select:focus{border-color:var(--focus);outline:1px solid var(--focus);outline-offset:-1px}
  /* The option popup is native and ignores the translucent --input, so give it a solid themed surface. */
  option{background:var(--bg, var(--vscode-dropdown-background));color:var(--fg, var(--vscode-dropdown-foreground))}
  input::placeholder{color:var(--placeholder)}
  .org-input{font-family:var(--mono);padding-left:22px !important}
  .mono-input{font-family:var(--mono)}
  .seg{display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--hover)}
  .tab{text-align:center;padding:4px;border-radius:calc(var(--r-sm) - 2px);cursor:pointer;color:var(--muted);user-select:none}
  .tab:hover{color:var(--fg);background:var(--hover)}
  .tab.active{background:var(--seg-on);color:var(--seg-on-fg);font-weight:600;box-shadow:0 1px 3px rgba(40,90,130,.15)}
  .amber{--amb:var(--pick-future, var(--vscode-charts-yellow, #c27c0e))}
  .lab.amber{color:var(--amb)}
  .seg.amber .tab.active{color:var(--amb);background:color-mix(in srgb, var(--amb) 16%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--amb) 45%, transparent)}
  .pick-group.promote{--promote:var(--pick-promote, var(--vscode-charts-green, #388a34))}
  .pick-group.future{--future:var(--pick-future, var(--vscode-charts-yellow, #c27c0e))}
  .pick-group{--g:var(--promote);border:1px solid var(--line);border-left:3px solid var(--g);border-radius:var(--r-sm);padding:10px;background:color-mix(in srgb, var(--g) 5%, var(--glass))}
  .pick-group.future{--g:var(--future)}
  .pick-group .lab{color:var(--g)}
  .pick-group .lab svg{flex-shrink:0;align-self:center}
  .pick-group .lab .cnt{white-space:nowrap;color:var(--g);background:color-mix(in srgb, var(--g) 16%, transparent);border-radius:10px;padding:0 7px}
  .pick-group .lab .cnt:empty{display:none}
  .pick-hint{font-size:11px;color:var(--muted);margin:-3px 0 6px}
  .pick-filter{margin-bottom:4px}
  .pick-list{max-height:200px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--input)}
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
  .btn{background:var(--accent);color:var(--accent-fg);border:1px solid var(--vscode-button-border, transparent);border-radius:var(--r-sm);padding:5px 12px;font:inherit;cursor:pointer;white-space:nowrap}
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
  .main{min-width:0;padding-bottom:26px}
  .topbar.glass{padding:7px 10px 7px 16px}
  .status-bar{display:none;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--line);border-left:3px solid var(--info);border-radius:var(--r-sm);font-size:12px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}
  .status-bar.show{display:flex}
  .status-info{border-left-color:var(--info);background:color-mix(in srgb, var(--info) 9%, transparent)}
  .status-success{border-left-color:var(--ok);background:color-mix(in srgb, var(--ok) 9%, transparent)}
  .status-warn{border-left-color:var(--warn);background:color-mix(in srgb, var(--warn) 10%, transparent)}
  .status-error{border-left-color:var(--err);background:color-mix(in srgb, var(--err) 10%, transparent)}
  .spinner{width:14px;height:14px;flex-shrink:0;border:2px solid color-mix(in srgb, var(--fg) 20%, transparent);border-top-color:var(--focus);border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-body{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
  .prog[hidden]{display:none}
  .prog{display:flex;flex-direction:column;gap:4px}
  .prog-track{height:6px;border-radius:3px;background:color-mix(in srgb, var(--fg) 12%, transparent);overflow:hidden}
  .prog-fill{height:100%;width:0;border-radius:3px;background:var(--focus);transition:width .35s ease}
  .prog-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .prog-meta #progPct{color:var(--fg);font-weight:600}
  .empty{border:1px dashed var(--line);border-radius:var(--r);padding:48px 24px;text-align:center;color:var(--muted)}
  .empty b{display:block;color:var(--fg);font-size:14px;font-weight:600;margin-bottom:4px}
  .empty svg{display:block;margin:0 auto 12px;opacity:.6}

  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .kpi{padding:10px 14px;background:var(--glass);border:1px solid var(--glass-line);border-radius:calc(var(--r) - 2px);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}
  .kpi b{display:block;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
  .kpi span{font-size:11px;color:var(--muted)}
  .kpi.warn b{color:var(--warn)}
  .kpi.ok b{color:var(--ok)}
  .results-header{display:flex;align-items:center;gap:8px}
  .results-title{font-weight:600}
  .results-badge{background:var(--badge);color:var(--badge-fg);border-radius:10px;padding:0 7px;min-width:20px;text-align:center;font-size:11px;font-weight:600}
  .results-header .sp{flex:1}

  .results.glass{padding:12px 14px}
  .results > * + *{margin-top:12px}
  .risk-tally{display:flex;gap:6px;flex-wrap:wrap}
  .risk-pill{--c:var(--muted);display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap;color:var(--c);background:color-mix(in srgb, var(--c) 12%, transparent);border:1px solid color-mix(in srgb, var(--c) 40%, transparent)}
  .risk-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--c)}
  .risk-pill.high{--c:var(--err)} .risk-pill.med{--c:var(--warn)} .risk-pill.low{--c:var(--ok)}

  /* Component list on the left, the selected component's story timeline on the right. */
  .component-list{display:grid;grid-template-columns:minmax(200px,260px) minmax(0,1fr);gap:14px;align-items:start}
  .comp-nav{display:flex;flex-direction:column;gap:1px;padding:6px;border-radius:calc(var(--r) - 4px);background:var(--glass);border:1px solid var(--glass-line);position:sticky;top:14px;max-height:calc(100vh - 28px);overflow-y:auto}
  .component-header{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:var(--r-sm);cursor:pointer;user-select:none;border:0;background:none;color:inherit;font:inherit;text-align:left;width:100%}
  .comp-nav{gap:10px;padding:0;background:none;border:0}
  .nav-sec{display:flex;flex-direction:column;gap:1px;padding:4px 5px 5px;border-radius:calc(var(--r) - 4px);background:var(--glass);border:1px solid var(--glass-line);box-shadow:var(--glass-shadow)}
  .nav-group{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 -5px 4px;padding:6px 14px 7px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--line)}
  button.nav-group{width:calc(100% + 10px);background:none;border-top:0;border-left:0;border-right:0;font-family:inherit;cursor:pointer;text-align:left;border-radius:calc(var(--r) - 4px) calc(var(--r) - 4px) 0 0}
  button.nav-group:hover{background:var(--hover)}
  button.nav-group:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}
  .nav-group .nav-title{display:flex;align-items:center;gap:6px;min-width:0}
  .nav-group .chev{flex-shrink:0;transition:transform .15s ease}
  .nav-sec.collapsed .nav-group .chev{transform:rotate(-90deg)}
  .nav-sec.collapsed .nav-group{margin-bottom:0;border-bottom-color:transparent;border-radius:calc(var(--r) - 4px)}
  .comp-nav:not(.searching) .nav-sec.collapsed .component-header{display:none}
  .nav-count{min-width:18px;padding:0 6px;border-radius:99px;text-align:center;font-size:10px;letter-spacing:0;color:var(--accent);background:color-mix(in srgb, var(--accent) 13%, transparent)}
  .component-header:hover{background:var(--hover)}
  .component-header.on{background:var(--sel);box-shadow:0 3px 12px rgba(47,134,196,.14)}
  .component-header:focus-visible{outline:1px solid var(--focus)}
  .component-name{font-family:var(--mono);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .component-count{font-size:11px;color:var(--muted);white-space:nowrap}
  .component-type{font-size:11px;background:var(--badge);color:var(--badge-fg);border-radius:10px;padding:0 8px;white-space:nowrap}
  .risk{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .risk-high{background:var(--err);box-shadow:0 0 8px color-mix(in srgb, var(--err) 60%, transparent)}
  .risk-med{background:var(--warn);box-shadow:0 0 8px color-mix(in srgb, var(--warn) 60%, transparent)}
  .risk-low{background:var(--ok);box-shadow:0 0 8px color-mix(in srgb, var(--ok) 60%, transparent)}
  .comp-detail{min-width:0}
  .component-stories{display:none}
  .component-stories.open{display:block}
  .component-stories + .component-stories.open{margin-top:18px}
  .detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .detail-name{font-family:var(--mono);font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
  .detail-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:2px}
  .timeline{position:relative;margin-top:10px;padding-left:24px}
  .timeline::before{content:'';position:absolute;left:6px;top:8px;bottom:8px;width:2px;border-radius:2px;background:linear-gradient(color-mix(in srgb, var(--promote) 55%, transparent),color-mix(in srgb, var(--promote) 18%, transparent))}
  .story-row{position:relative;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:9px 12px;margin-bottom:8px;border-radius:calc(var(--r) - 4px);background:var(--card);border:1px solid var(--glass-line);box-shadow:var(--glass-shadow)}
  .story-row::before{content:'';position:absolute;left:-23px;top:14px;width:9px;height:9px;border-radius:50%;background:var(--bg);border:3px solid var(--promote)}
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
  .theme-toggle{display:inline-flex;border:1px solid var(--line);border-radius:var(--r-sm);padding:2px;background:var(--hover);gap:2px;flex-shrink:0}
  .theme-toggle button{display:inline-flex;align-items:center;gap:5px;background:none;border:0;color:var(--muted);padding:3px 8px;border-radius:calc(var(--r-sm) - 2px);font:inherit;font-size:12px;cursor:pointer}
  .theme-toggle button:hover{color:var(--fg);background:var(--hover)}
  .theme-toggle button:focus-visible{outline:1px solid var(--focus)}
  .theme-toggle button[aria-pressed="true"]{background:var(--seg-on);color:var(--seg-on-fg);font-weight:600;box-shadow:0 1px 3px rgba(40,90,130,.15)}
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
  .comp-search{display:flex;align-items:center;gap:10px;margin:0 0 12px}
  .comp-search input{flex:0 1 420px;width:100%;min-width:0;padding:7px 12px 7px 32px;border-radius:var(--r-sm);border:1px solid var(--glass-line);background:var(--glass) no-repeat 11px 50%/14px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%237a97ad' stroke-width='1.6'%3E%3Ccircle cx='7' cy='7' r='5'/%3E%3Cpath d='M11 11l3.5 3.5' stroke-linecap='round'/%3E%3C/svg%3E");color:var(--fg);font:inherit;font-size:12.5px;outline:none}
  .comp-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)}
  .comp-search-count{font-size:11.5px;color:var(--muted);white-space:nowrap}
  .story-search{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0}
  .story-search input{width:210px;max-width:100%;min-width:0;padding:5px 10px 5px 28px;border-radius:var(--r-sm);border:1px solid var(--glass-line);background:var(--glass) no-repeat 9px 50%/13px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%237a97ad' stroke-width='1.6'%3E%3Ccircle cx='7' cy='7' r='5'/%3E%3Cpath d='M11 11l3.5 3.5' stroke-linecap='round'/%3E%3C/svg%3E");color:var(--fg);font:inherit;font-size:12px;outline:none}
  .story-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent)}
  .story-search-count{font-size:11px;color:var(--muted);white-space:nowrap}
  .story-empty{padding:10px 12px;font-size:12px;color:var(--muted)}
  .story-row[hidden],.story-empty[hidden]{display:none}
  .comp-empty{padding:14px 10px;font-size:12px;color:var(--muted);text-align:center}
  .component-header mark{background:color-mix(in srgb, var(--accent) 22%, transparent);color:inherit;border-radius:3px;padding:0 1px}
  .no-common{padding:32px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:var(--r)}
  .no-common b{display:block;color:var(--ok);font-size:14px;margin-bottom:4px}
  .legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:8px}
  .pr-pill,.story-release-tag,.moved-tag{border-radius:6px}
  .pr-pill.pr-skip{opacity:.45;text-decoration:line-through}
  .story-touch{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:6px}
  .touch-spin{--amb:var(--pick-future, var(--vscode-charts-yellow, #c27c0e));width:10px;height:10px;border:2px solid color-mix(in srgb, var(--amb) 30%, transparent);border-top-color:var(--amb);border-radius:50%;animation:spin .8s linear infinite;flex:none}
  .moved-tag{font-size:11px;color:var(--warn);border:1px dashed color-mix(in srgb, var(--warn) 55%, transparent);padding:0 7px}
  .kpi-env{grid-column:span 2;display:flex;flex-direction:column;gap:2px;min-width:0}
  .kpi-env .ec-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .kpi-env .ec-row b{display:inline;font-size:13px;font-weight:600}
  .kpi-env .ec-sub b{color:var(--muted)}
  .kpi-env .ec-add b{color:var(--warn)}
  .kpi-env .ec-total{border-top:1px solid var(--glass-line);margin-top:3px;padding-top:4px}
  .kpi-env .ec-total span{color:var(--fg);font-weight:600}
  .kpi-env .ec-total b{font-size:18px}
  @media (max-width:520px){.kpi-env{grid-column:auto}}

  @media (max-width:720px){
    .app{grid-template-columns:1fr}
    .rail{position:static;height:auto}
  }
  @media (max-width:640px){
    .component-list{grid-template-columns:1fr}
    .comp-nav{position:static;max-height:240px}
  }
</style>
</head>
<body>
<div class="app">

<aside class="rail glass stack">
  <div class="brand"><img class="brand-logo" src="${this.logoUri}" alt="" width="34" height="34"/><div>Release Overlap Inspector<small>Shared metadata between releases or stories</small></div></div>

  <div>
    <div class="lab">Salesforce org</div>
    <div class="org-row">
      <div class="org-wrap">
        <span class="org-dot" id="orgDot"></span>
        <input id="orgAlias" class="org-input" type="text" value="${safeOrg}" placeholder="Org alias, e.g. RBKINT-CPQAI" autocomplete="off" list="orgList"/>
        <datalist id="orgList">${orgOptions}</datalist>
      </div>
      <button class="btn" onclick="connectOrg()">Connect</button>
    </div>
  </div>

  <div id="modeCard" class="stack" style="display:none">
    <div>
      <label class="lab" for="pipelineSel">Pipeline</label>
      <select id="pipelineSel" onchange="onPipelinePick(this.value)"></select>
      <div class="pick-hint" style="margin:5px 0 0">Its environments are offered under Compare against › Bundled environment</div>
    </div>

    <div>
      <div class="lab">Mode</div>
      <div class="seg">
        <div class="tab active" id="tabRelease" onclick="switchMode('release')">By release</div>
        <div class="tab" id="tabStory" onclick="switchMode('story')">By user story</div>
      </div>
    </div>

    <div>
      <div class="lab">PR source</div>
      <div class="seg amber">
        <div class="tab active" id="srcFeature" onclick="setPrSource('feature')" title="PRs raised from the story's feature branch">Feature branch</div>
        <div class="tab" id="srcPromo" onclick="setPrSource('promo')" title="PRs raised from promotion branches into the story's next environment">Promotion</div>
      </div>
      <div class="pick-hint" id="srcHint" style="margin:5px 0 0">PRs raised from each story's feature branch</div>
      <div id="envPick" style="display:none;margin-top:8px">
        <label class="lab amber" for="promoEnvSel">PR target environment</label>
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
      <div>
        <div class="lab amber">Compare against</div>
        <div class="seg amber">
          <div class="tab active" id="cmpRelease" onclick="setCompareBy('release')" title="Stories tagged to the future planned releases you pick">Future releases</div>
          <div class="tab" id="cmpEnv" onclick="setCompareBy('env')" title="Every other story currently sitting in the environment you bundle from">Environment</div>
        </div>
      </div>
      <div class="pick-group future" id="envGroup" style="display:none">
        <div class="lab"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 14h5M8 11v3" stroke="currentColor" stroke-width="1.6"/></svg>Bundled environment</div>
        <div class="pick-hint">Copado environment you bundle from. Its stories outside the releases to promote are checked.</div>
        <select id="envSel" onchange="onEnvPick(this.value)"></select>
      </div>
      <div class="pick-group future" id="futureGroup">
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
  <div class="topbar glass">
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
    <div class="status-body">
      <span id="statusText"></span>
      <div class="prog" id="prog" hidden>
        <div class="prog-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="progTrack"><div class="prog-fill" id="progFill"></div></div>
        <div class="prog-meta"><span id="progPct"></span><span id="progCount"></span><span id="progEta"></span></div>
      </div>
    </div>
  </div>

  <div class="empty" id="emptyState">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11 7"/></svg>
    <b>No analysis yet</b>
    Connect to an org, choose the release to promote and the future releases, then run Analyse.
  </div>

  <div id="resultsSection" class="stack" style="display:none">
    <div class="kpis" id="statRow"></div>
    <div class="results glass">
      <div class="results-header">
        <span class="results-title">Shared components</span>
        <span class="results-badge" id="commonBadge">0</span>
        <span class="sp"></span>
        <span class="risk-tally" id="riskTally"></span>
        <button class="btn btn-sec btn-sm" id="btnToggleAll" onclick="toggleAll()">Expand all</button>
        <button class="btn btn-sec btn-sm" onclick="resetAll()">Reset</button>
      </div>
      <div class="comp-search" id="compSearchWrap" style="display:none">
        <input type="search" id="compSearch" placeholder="Search components by name" autocomplete="off" spellcheck="false" oninput="filterComponents()"/>
        <span class="comp-search-count" id="compSearchCount"></span>
      </div>
      <div id="componentList" class="component-list"></div>
      <div class="legend" id="legend"></div>
    </div>
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
  let _compareBy = SAVED.compareBy === 'env' ? 'env' : 'release';
  // Kept by name so a saved choice survives reconnecting (and works across orgs with the same environment names).
  let _envName = SAVED.envName || '';
  let _environments = [];
  let _pipelineName = SAVED.pipeline || '';
  let _pipelines = [];
  let _last = null;

  function currentPrefs() {
    return { prSource: _prSource, mode: currentMode, theme: currentTheme, promoEnv: _promoEnv, compareBy: _compareBy, envName: _envName, pipeline: _pipelineName };
  }

  function refreshPrefsState() {
    const cur = currentPrefs();
    const hasSaved = !!SAVED.prSource;
    const same = hasSaved && cur.prSource === SAVED.prSource && cur.mode === SAVED.mode && cur.theme === SAVED.theme && cur.promoEnv === (SAVED.promoEnv || '')
      && cur.compareBy === (SAVED.compareBy || 'release') && cur.envName === (SAVED.envName || '') && cur.pipeline === (SAVED.pipeline || '');
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

  // Which PRs actually change a component is only known from git, so it is checked when a component is
  // selected and kept per analysis run, PR source and picked environment.
  let _run = 0;
  const _touch = new Map();
  const touchKey = comp => _run + '|' + _prSource + '|' + (_prSource === 'promo' ? _promoEnv || 'auto' : '') + '|' + comp.type + '/' + comp.name;
  const touchState = (s, comp) => {
    const t = _touch.get(touchKey(comp));
    // Not checked yet counts as pending, so a row never shows PRs that turn out not to change the component.
    if (!t || t.pending) return { pending: true };
    const r = t.results[s.id];
    return r ? { touching: new Set(r.touching), unknown: new Set(r.unknown) } : null;
  };
  // PRs worth offering for this component: those that change it, plus any that could not be checked.
  const prsFor = (s, comp) => {
    const prs = prsOf(s);
    const t = touchState(s, comp);
    if (t && t.pending) return [];
    return !t ? prs : prs.filter(p => t.touching.has(p.number) || t.unknown.has(p.number));
  };

  // Checks every component of the results for the current PR source / environment in one batch, the
  // selected one first, so switching between components needs no waiting.
  function requestAllTouch(first) {
    const order = first ? [first, ..._comps.filter(c => c !== first)] : _comps;
    if (first && _touch.get(touchKey(first))?.pending) vscode.postMessage({ command: 'prTouchFirst', key: touchKey(first) });
    const jobs = [];
    for (const comp of order) {
      const key = touchKey(comp);
      if (_touch.has(key)) continue;
      const stories = comp.excludeStories.filter(s => !lookupFailed(s) && prsOf(s).length)
        .map(s => ({ id: s.id, name: s.name, repoUrl: s.repoUrl || '', baseBranch: s.baseBranch, prs: prsOf(s) }));
      if (!stories.length) { _touch.set(key, { results: {} }); continue; }
      _touch.set(key, { pending: true });
      jobs.push({ key, componentName: comp.name, componentType: comp.type, stories });
    }
    if (jobs.length) vscode.postMessage({ command: 'checkPrTouchAll', run: _run, source: _prSource, jobs });
  }

  function refreshTouchRows(key) {
    _rows.forEach((r, i) => {
      if (touchKey(r.comp) !== key) return;
      const act = document.getElementById('act-' + i);
      const info = document.getElementById('pri-' + i);
      if (act) act.innerHTML = actionsHtml(i);
      if (info) info.innerHTML = prInfoHtml(r.s, r.comp);
    });
  }

  function setPrSource(src) {
    _prSource = src === 'promo' ? 'promo' : 'feature';
    document.getElementById('srcFeature').classList.toggle('active', _prSource === 'feature');
    document.getElementById('srcPromo').classList.toggle('active', _prSource === 'promo');
    document.getElementById('srcHint').textContent = _prSource === 'promo'
      ? 'PRs from Completed promotions into the environment right after the story\\'s origin (latest SFDX Promote and SFDX Deploy successful)'
      : 'PRs raised from each story\\'s feature branch';
    document.getElementById('legend').innerHTML = _prSource === 'promo'
      ? '<span><b>PR Diff</b> shows only what the story\\'s merge brought into the promotion branch</span><span><b>#N</b> shows a single promotion PR</span><span><b>All PRs Diff</b> combines every qualifying promotion PR</span>'
      : '<span><b>PR Diff</b> shows only the story\\'s own commits, without base-branch changes</span><span><b>#N</b> shows a single PR</span><span><b>Branch Diff</b> compares the feature branch with its base when there is no PR</span>';
    document.getElementById('envPick').style.display = _prSource === 'promo' ? 'block' : 'none';
    vscode.setState(Object.assign({}, vscode.getState() || {}, { prSource: _prSource }));
    refreshPrefsState();
    if (_last) renderResults(_last.components, _last.mode);
  }

  function setCompareBy(by) {
    _compareBy = by === 'env' ? 'env' : 'release';
    document.getElementById('cmpRelease').classList.toggle('active', _compareBy === 'release');
    document.getElementById('cmpEnv').classList.toggle('active', _compareBy === 'env');
    document.getElementById('futureGroup').style.display = _compareBy === 'release' ? '' : 'none';
    document.getElementById('envGroup').style.display = _compareBy === 'env' ? '' : 'none';
    renderReleasePickers();
    refreshPrefsState();
  }

  function onEnvPick(id) {
    const env = _environments.find(e => e.id === id);
    _envName = env ? env.name : '';
    renderCrumb();
    refreshPrefsState();
  }

  function renderEnvironments(loading) {
    const sel = document.getElementById('envSel');
    const picked = _environments.find(e => e.name === _envName);
    const empty = loading ? 'Loading environments…' : !_pipelineName ? 'Pick a pipeline first' : _environments.length ? 'Select an environment' : 'No environments in this pipeline';
    sel.innerHTML = '<option value="">' + esc(empty) + '</option>' +
      _environments.map(e => '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>').join('');
    sel.value = picked ? picked.id : '';
  }

  function renderPipelines() {
    const sel = document.getElementById('pipelineSel');
    const picked = _pipelines.find(p => p.name === _pipelineName);
    sel.innerHTML = '<option value="">' + (_pipelines.length ? 'Select a pipeline' : 'No pipelines found') + '</option>' +
      _pipelines.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.active ? '' : ' (inactive)') + '</option>').join('');
    sel.value = picked ? picked.id : '';
  }

  function onPipelinePick(id) {
    const p = _pipelines.find(x => x.id === id);
    _pipelineName = p ? p.name : '';
    _environments = [];
    renderEnvironments(!!p);
    if (p) vscode.postMessage({ command: 'fetchPipelineEnvs', pipelineId: p.id });
    renderCrumb();
    refreshPrefsState();
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
    // When every analysed story has the same next environment, "auto" IS that environment: name it in the auto option
    // and leave it out of the list, so the same choice is not offered twice.
    const nextEnvs = [...new Set(components.flatMap(c => c.excludeStories.map(s => s.nextEnv).filter(Boolean)))];
    const autoEnv = nextEnvs.length === 1 ? nextEnvs[0] : '';
    if (autoEnv && _promoEnv === autoEnv) _promoEnv = '';
    const envs = [...rank.keys()].filter(e => e !== autoEnv).sort((a, b) => rank.get(a) - rank.get(b) || a.localeCompare(b));
    const autoLabel = autoEnv ? 'Next environment – ' + autoEnv + ' (auto)'
      : nextEnvs.length > 1 ? 'Next environment (auto: each story\\'s own – ' + nextEnvs.join(', ') + ')'
      : 'Next environment (auto)';
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
      '<option value="">' + esc(autoLabel) + '</option>' +
      envs.map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('');
    document.getElementById('promoEnvSel').value = _promoEnv;
  }

  function connectOrg() {
    const alias = document.getElementById('orgAlias').value.trim();
    if (!alias) { showStatus('Please enter an org alias.', 'error'); return; }
    resetAll();
    renderEnvOptions([]);
    _awaitingReleases = true;
    showStatus('Connecting to ' + alias + ' and loading releases…', 'info', true);
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
    const theirs = new Set(_compareBy === 'env' ? [] : _picked[other]);
    const rows = _releases.filter(r => mine.has(r.id) || !q || releaseLabel(r).toLowerCase().includes(q))
      .sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
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
    const against = _compareBy === 'env'
      ? (_envName ? ' against other stories in <span class="c-f">' + esc(_envName) + '</span>' : '')
      : (_picked.future.length ? ' against <span class="c-f">' + _picked.future.map(nameOf).join(', ') + '</span>' : '');
    el.innerHTML = 'Promoting <span class="c-p">' + _picked.promote.map(nameOf).join(', ') + '</span>' + against;
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
    if (box.checked) document.getElementById(list + 'List').scrollTop = 0;
  }

  function toggleAll() {
    const btn = document.getElementById('btnToggleAll');
    const open = btn.textContent === 'Expand all';
    if (open) {
      document.querySelectorAll('.component-stories').forEach(el => el.classList.add('open'));
      requestAllTouch();
    }
    else toggleComponent(_selected);
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
    if (_compareBy === 'env') {
      const env = _environments.find(e => e.name === _envName);
      if (!_pipelineName) { showStatus('Please pick a pipeline first.', 'error'); return; }
      if (!env) { showStatus('Please pick the environment you bundle from, e.g. RBKUAT.', 'error'); return; }
      showStatus('Fetching the stories sitting in ' + env.name + '…', 'info', true);
      showResultsArea(false);
      document.getElementById('btnAnalyseReleases').disabled = true;
      const pipeline = _pipelines.find(p => p.name === _pipelineName);
      vscode.postMessage({ command: 'analyseEnv', promoteIds, envId: env.id, envName: env.name, pipelineId: pipeline ? pipeline.id : '' });
      return;
    }
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

  let _selected = 0;
  let _selectedKey = '';
  let _comps = [];

  function toggleComponent(id, reveal) {
    _selected = id;
    const hdr = document.querySelector('.component-header[data-idx="' + id + '"]');
    if (hdr) _selectedKey = hdr.dataset.key;
    document.querySelectorAll('.component-stories').forEach(el => el.classList.toggle('open', el.id === 'stories-' + id));
    document.querySelectorAll('.component-header').forEach(el => el.classList.toggle('on', el.dataset.idx === String(id)));
    requestAllTouch(_comps[id]);
    const btn = document.getElementById('btnToggleAll');
    if (btn) btn.textContent = 'Expand all';
    // Picking an item low in a long list leaves the page scrolled past the detail, so go back to the top.
    if (reveal && window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Survives re-renders (PR source / environment switches) so a collapsed type stays collapsed.
  const _collapsedTypes = new Set();

  function toggleType(btn) {
    const sec = btn.closest('.nav-sec');
    const shut = !sec.classList.contains('collapsed');
    sec.classList.toggle('collapsed', shut);
    btn.setAttribute('aria-expanded', String(!shut));
    if (shut) _collapsedTypes.add(btn.dataset.type); else _collapsedTypes.delete(btn.dataset.type);
  }

  function filterComponents() {
    const input = document.getElementById('compSearch');
    const nav = document.querySelector('.comp-nav');
    if (!input || !nav) return;
    const q = input.value.trim().toLowerCase();
    // While searching, matches show even inside collapsed types.
    nav.classList.toggle('searching', !!q);
    let shown = 0, total = 0, firstShown = null, selectedShown = false;
    nav.querySelectorAll('.nav-sec').forEach(sec => {
      let secShown = 0;
      sec.querySelectorAll('.component-header').forEach(h => {
        total++;
        const nameEl = h.querySelector('.component-name');
        const name = nameEl.dataset.name || nameEl.textContent;
        nameEl.dataset.name = name;
        const at = q ? name.toLowerCase().indexOf(q) : 0;
        const hit = !q || at >= 0;
        h.style.display = hit ? '' : 'none';
        nameEl.innerHTML = q && hit ? esc(name.slice(0, at)) + '<mark>' + esc(name.slice(at, at + q.length)) + '</mark>' + esc(name.slice(at + q.length)) : esc(name);
        if (hit) {
          secShown++; shown++;
          if (firstShown === null) firstShown = h.dataset.idx;
          if (h.dataset.idx === String(_selected)) selectedShown = true;
        }
      });
      sec.style.display = secShown ? '' : 'none';
      const cnt = sec.querySelector('.nav-count');
      if (cnt) cnt.textContent = q ? secShown + '/' + sec.querySelectorAll('.component-header').length : sec.querySelectorAll('.component-header').length;
    });
    let empty = nav.querySelector('.comp-empty');
    if (!shown) {
      if (!empty) { empty = document.createElement('div'); empty.className = 'comp-empty'; nav.appendChild(empty); }
      empty.textContent = 'No component matches "' + input.value.trim() + '"';
    } else if (empty) empty.remove();
    document.getElementById('compSearchCount').textContent = q ? shown + ' of ' + total : '';
    if (q && shown && !selectedShown) toggleComponent(firstShown);
  }

  // Matches anywhere in the story name and its PR numbers, so "19913", "US-0019913", "11074" and "#11074" all work.
  function filterStories(input) {
    const box = input.closest('.component-stories');
    const q = input.value.trim().toLowerCase();
    const rows = box.querySelectorAll('.story-row');
    let shown = 0;
    rows.forEach(r => {
      const hit = !q || r.dataset.find.indexOf(q) >= 0;
      r.hidden = !hit;
      if (hit) shown++;
    });
    input.parentElement.querySelector('.story-search-count').textContent = q ? shown + ' of ' + rows.length : '';
    const empty = box.querySelector('.story-empty');
    empty.hidden = shown > 0;
    empty.textContent = 'No story or PR matches "' + input.value.trim() + '"';
  }

  let _orgInstanceUrl = '';
  // Set by Connect until the new org's releases arrive; results of an analysis started before that are dropped.
  let _awaitingReleases = false;

  function resetAll() {
    showResultsArea(false);
    document.getElementById('componentList').innerHTML = '';
    document.getElementById('compSearch').value = '';
    document.getElementById('compSearchCount').textContent = '';
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
    const prs = prsFor(r.s, r.comp);
    if (!prs.length) return;
    const kind = _prSource === 'promo' ? 'promotion ' : '';
    const label = prNumber === null ? (prs.length > 1 ? 'all ' + kind + 'PRs' : kind + 'PR #' + prs[0].number) : kind + 'PR #' + prNumber;
    showStatus('Reading ' + label + ' for ' + r.comp.name + ' (' + r.s.name + ')…', 'info', true);
    scrollToStatus();
    vscode.postMessage({
      command: 'viewPrDiff', storyName: r.s.name, repoUrl: r.s.repoUrl, baseBranch: r.s.baseBranch, baseBranchMissing: r.s.baseBranchMissing,
      prs, prNumber, componentName: r.comp.name, componentType: r.comp.type, source: _prSource,
      env: _prSource === 'promo' ? envOf(r.s) : '',
    });
  }

  function branchDiff(row) {
    const r = _rows[row];
    if (r) viewDiff(r.s.name, r.s.baseBranch, r.s.featureBranch, r.comp.name, r.comp.type, r.s.repoUrl);
  }

  function prInfoHtml(s, comp) {
    const repo = s.repoUrl ? '<div class="story-branch">Repo: ' + esc(s.repoUrl.replace(/^https?:\\/\\/[^/]+\\//, '')) + '</div>' : '';
    const promo = _prSource === 'promo';
    const warn = repo + (s.baseBranchMissing && !promo ? '<div class="story-no-branch">⚠ No base branch on story — comparing with master</div>' : '');
    if (lookupFailed(s)) return warn + '<div class="story-no-branch">⚠ Could not read ' + (promo ? 'promotions' : 'pull requests') + '</div>';
    const prs = prsOf(s);
    const pr = promo ? promoOf(s) : null;
    const via = pr && pr.promotions.length
      ? '<div class="story-branch">Promotions → ' + esc(pr.env) + ': ' + pr.promotions.map(esc).join(', ') + '</div>' : '';
    if (prs.length === 0) return warn + via + '<div class="story-no-pr">' + esc(pr ? (pr.note || 'No qualified promotions, hence no PRs shown') : 'No PR raised') + '</div>';
    const t = comp ? touchState(s, comp) : null;
    if (t && t.pending) return warn + via + '<div class="story-touch"><span class="touch-spin"></span>Checking which of ' + prs.length + ' PR' + (prs.length === 1 ? '' : 's') + ' change ' + esc(comp.name) + '…</div>';
    const skipped = t ? prs.filter(p => !t.touching.has(p.number) && !t.unknown.has(p.number)) : [];
    const note = skipped.length && skipped.length < prs.length
        ? '<div class="story-touch">' + skipped.map(p => '#' + p.number).join(', ') + ' do' + (skipped.length === 1 ? 'es' : '') + ' not change ' + esc(comp.name) + '</div>'
        : '';
    return warn + via + '<div class="story-prs">' + prs.map(p => {
      const state = p.merged ? 'Merged' : (p.state || 'Open');
      const skip = skipped.includes(p);
      const cls = 'pr-pill pr-' + String(state).toLowerCase() + (skip ? ' pr-skip' : '');
      const tip = skip ? ' title="Does not change ' + esc(comp.name) + '"' : '';
      const text = '#' + p.number + (p.promotion ? ' ' + esc(p.promotion) : '') + ' ' + esc(String(state).toLowerCase()) + (p.targetBranch ? ' → ' + esc(p.targetBranch) : '');
      return /^https?:\\/\\//.test(p.url)
        ? '<a href="#" class="' + cls + '"' + tip + ' data-url="' + esc(p.url) + '" onclick="openUrl(this.dataset.url);return false;">' + text + '</a>'
        : '<span class="' + cls + '"' + tip + '>' + text + '</span>';
    }).join('') + '</div>' + note;
  }

  function actionsHtml(row) {
    const { s, comp } = _rows[row];
    const promo = _prSource === 'promo';
    const hasBranch = !!(s.featureBranch && s.featureBranch.length > 0);
    const all = prsOf(s);
    const branchBtn = tip => '<button class="btn btn-sm btn-pr" title="' + tip + '" onclick="branchDiff(' + row + ')">Branch Diff</button>';
    if (all.length > 0) {
      const t = touchState(s, comp);
      if (t && t.pending) return '<span class="no-branch">Checking PRs…</span>';
      const prs = prsFor(s, comp);
      if (prs.length === 0) {
        const none = '<span class="no-branch" title="Copado lists ' + esc(comp.name) + ' on this story, but none of its ' + (promo ? 'promotion ' : '') + 'PRs change it">No PR changes this component</span>';
        return none + (!promo && hasBranch ? branchBtn('Feature branch vs base branch diff') : '');
      }
      return '<button class="btn btn-sm btn-diff" title="' + (promo ? 'Changes to this component from the story merges in the qualified promotion PRs that change it' : 'Changes to this component across the PRs that change it, story commits only') + '" onclick="prDiff(' + row + ',null)">' +
          (prs.length > 1 ? 'All PRs Diff' : 'PR Diff' + (all.length > 1 ? ' #' + prs[0].number : '')) + '</button>' +
        (prs.length > 1
          ? prs.map(p => '<button class="btn btn-sm btn-pr" title="Only PR #' + p.number + (p.promotion ? ' (' + esc(p.promotion) + ')' : '') + '" onclick="prDiff(' + row + ',' + p.number + ')">#' + p.number + '</button>').join('')
          : '');
    }
    if (promo) return '<span class="no-branch">No promotion PR</span>';
    if (hasBranch) return branchBtn('No PR — falls back to the feature branch vs base branch diff');
    return '<span class="no-branch">No branch</span>';
  }

  function envCountsHtml(envName) {
    const others = _last.envStoryCount || 0, own = _last.envOwnCount || 0, moved = _last.movedBackCount || 0;
    const line = (label, n, cls) => '<div class="ec-row' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><b>' + n + '</b></div>';
    return '<div class="kpi kpi-env">' +
      line('Stories sitting in ' + envName, others + own) +
      line('Minus your releases\\' stories in ' + envName, '− ' + own, 'ec-sub') +
      line('Other stories in ' + envName, others) +
      line('Plus deployed to ' + envName + ' and moved back', '+ ' + moved, 'ec-add') +
      line('Stories checked', others + moved, 'ec-total') +
      '</div>';
  }

  function movedBackHtml(s) {
    const m = s.movedBack;
    if (!m) return '';
    const day = m.deployedAt ? new Date(m.deployedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return '<div class="story-branch">Deployed to ' + esc(m.env) + ' by ' + esc(m.promotion) + (day ? ' on ' + esc(day) : '') + ', now in ' + esc(m.now) + '</div>';
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
    document.getElementById('prog').hidden = true;
    _progStep = null;
  }

  // Real counts from the extension; the time left is only shown once this step has measured its own pace.
  let _progStep = null;
  function showProgress(m) {
    const key = m.step + '|' + m.label;
    const now = Date.now();
    if (!_progStep || _progStep.key !== key) _progStep = { key, start: now, firstDone: null, firstAt: 0 };
    if (m.done > 0 && _progStep.firstDone === null) { _progStep.firstDone = m.done; _progStep.firstAt = now; }
    const keep = _progStep;
    showStatus('Step ' + m.step + ' of ' + m.steps + ' · ' + m.label + '…', 'info', true);
    _progStep = keep;
    const pct = m.total ? Math.floor(m.done * 100 / m.total) : 0;
    const prog = document.getElementById('prog');
    prog.hidden = false;
    document.getElementById('progFill').style.width = pct + '%';
    document.getElementById('progTrack').setAttribute('aria-valuenow', String(pct));
    document.getElementById('progPct').textContent = pct + '%';
    const unit = m.unit === 'story' ? (m.total === 1 ? 'story' : 'stories') : m.unit === 'release' ? (m.total === 1 ? 'release' : 'releases') : (m.total === 1 ? 'query' : 'queries');
    document.getElementById('progCount').textContent = m.done + ' of ' + m.total + ' ' + unit;
    let eta = '';
    const s = _progStep;
    if (s && s.firstDone !== null && m.done > s.firstDone && m.done < m.total) {
      const rate = (m.done - s.firstDone) / (now - s.firstAt);
      const left = Math.ceil((m.total - m.done) / rate / 1000);
      eta = '~' + (left >= 60 ? Math.floor(left / 60) + 'm ' + (left % 60) + 's' : left + 's') + ' left';
    }
    document.getElementById('progEta').textContent = eta;
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
    const envName = esc((_last && _last.envName) || 'environment');
    statRow.innerHTML =
      kpi(components.length, 'Shared components', components.length ? '' : 'ok') +
      (mode === 'release' ? kpi(futureReleaseNames.length, 'Future releases affected') : '') +
      (mode === 'env' ? envCountsHtml(envName) : '') +
      kpi(allStories.size, mode === 'story' ? 'Stories involved' : mode === 'env' ? envName + ' stories involved' : 'Future-release stories') +
      kpi(noPr, _prSource === 'promo' ? 'Stories without a promotion PR' : 'Stories without a PR', noPr ? 'warn' : '');

    const tally = document.getElementById('riskTally');
    if (components.length === 0) {
      tally.innerHTML = '';
      document.getElementById('compSearchWrap').style.display = 'none';
      list.style.display = 'block';
      list.innerHTML = '<div class="no-common"><b>No shared components</b>Both sides touch completely separate metadata.</div>';
      return;
    }
    list.style.display = '';

    components = components.slice().sort((a, b) =>
      String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    const typeCount = {};
    components.forEach(c => { typeCount[c.type] = (typeCount[c.type] || 0) + 1; });

    _comps = components;
    _rows = [];
    const navItems = [];
    const counts = { high: 0, med: 0, low: 0 };
    const details = components.map((comp, idx) => {
      const storyRows = comp.excludeStories.map(s => {
        const row = _rows.push({ s, comp }) - 1;
        const find = [s.name].concat(prsOf(s).map(p => '#' + p.number)).join(' ').toLowerCase();
        return '<div class="story-row" data-find="' + esc(find) + '">' +
          '<div class="story-info">' +
            '<div class="story-top"><span class="story-name">' + storyNameHtml(s) + '</span>' +
              (s.releaseName ? '<span class="story-release-tag">' + esc(s.releaseName) + '</span>' : '') +
              (s.movedBack ? '<span class="moved-tag" title="Still deployed in ' + esc(s.movedBack.env) + ', though the story itself was moved back">Moved back to ' + esc(s.movedBack.now) + '</span>' : '') + '</div>' +
            branchHtml(s) +
            movedBackHtml(s) +
            '<div id="pri-' + row + '">' + prInfoHtml(s, comp) + '</div>' +
          '</div>' +
          '<div class="story-actions" id="act-' + row + '">' + actionsHtml(row) + '</div>' +
        '</div>';
      }).join('');

      const n = comp.excludeStories.length;
      const anyNoPr = comp.excludeStories.some(s => !prsOf(s).length);
      const risk = n >= 2 && anyNoPr ? 'high' : (n >= 2 || anyNoPr ? 'med' : 'low');
      const withPr = comp.excludeStories.filter(s => prsOf(s).length).length;
      const tip = riskTip(risk, n, n - withPr);
      counts[risk]++;
      if (idx === 0 || components[idx - 1].type !== comp.type) {
        const shut = _collapsedTypes.has(comp.type);
        navItems.push((idx ? '</div>' : '') + '<div class="nav-sec' + (shut ? ' collapsed' : '') + '">' +
          '<button type="button" class="nav-group" data-type="' + esc(comp.type) + '" aria-expanded="' + !shut + '" onclick="toggleType(this)" title="Show or hide ' + esc(comp.type) + ' components">' +
            '<span class="nav-title"><svg class="chev" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>' + esc(comp.type) + '</span>' +
            '<span class="nav-count">' + typeCount[comp.type] + '</span></button>');
      }
      navItems.push(
        '<button type="button" class="component-header" data-idx="' + idx + '" data-key="' + esc(comp.type + '/' + comp.name) + '" onclick="toggleComponent(' + idx + ', true)" title="' + esc(comp.name) + ' · ' + tip + '">' +
          '<span class="risk risk-' + risk + '"></span>' +
          '<span class="component-name">' + esc(comp.name) + '</span>' +
          '<span class="component-count">' + n + '</span>' +
        '</button>');
      return '<div class="component-stories" id="stories-' + idx + '">' +
          '<div class="detail-head"><div><div class="detail-name">' + esc(comp.name) + '</div>' +
            '<div class="detail-sub"><span class="component-type">' + esc(comp.type) + '</span>' +
              n + ' stor' + (n === 1 ? 'y' : 'ies') + ' · ' + (withPr === 0 ? 'none' : withPr + ' of ' + n) + ' with a ' + (_prSource === 'promo' ? 'promotion ' : '') + 'PR</div></div>' +
            (n > 1 ? '<div class="story-search"><input type="search" placeholder="Find US or PR number" autocomplete="off" spellcheck="false" aria-label="Find a story or PR in ' + esc(comp.name) + '" oninput="filterStories(this)"/><span class="story-search-count"></span></div>' : '') +
            '<span class="risk-pill ' + risk + '" title="' + tip + '">' + RISK_LABEL[risk] + '</span></div>' +
          '<div class="timeline">' + storyRows + '<div class="story-empty" hidden></div></div>' +
        '</div>';
    }).join('');

    tally.innerHTML = ['high', 'med', 'low'].filter(r => counts[r])
      .map(r => '<span class="risk-pill ' + r + '" title="' + riskTip(r) + '">' + counts[r] + ' ' + RISK_LABEL[r] + '</span>').join('');
    list.innerHTML = '<nav class="comp-nav" aria-label="Shared components">' + navItems.join('') + '</div></nav><div class="comp-detail">' + details + '</div>';
    const keep = components.findIndex(c => c.type + '/' + c.name === _selectedKey);
    toggleComponent(keep >= 0 ? keep : 0);
    document.getElementById('compSearchWrap').style.display = '';
    filterComponents();
  }

  const RISK_LABEL = { high: 'Needs review', med: 'Check', low: 'Clear' };
  function riskTip(r, n, missing) {
    const pr = _prSource === 'promo' ? 'promotion PR' : 'PR';
    if (n === undefined) {
      return { high: '2+ stories · a ' + pr + ' missing',
               med: '2+ stories · all have a ' + pr + ', or 1 story · no ' + pr,
               low: '1 story · has a ' + pr }[r];
    }
    const stories = n === 1 ? '1 story' : n + ' stories';
    const prs = missing === 0 ? (n === 1 ? 'has a ' : 'all have a ') + pr
      : missing === n ? (n === 1 ? 'no ' + pr : 'none has a ' + pr)
      : missing + ' of ' + n + ' without a ' + pr;
    return stories + ' · ' + prs;
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'prefsSaved':
        SAVED = msg.prefs;
        refreshPrefsState();
        break;
      case 'orgHistory':
        document.getElementById('orgList').innerHTML = (msg.orgs || []).map(o => '<option value="' + esc(o) + '"></option>').join('');
        break;
      case 'releases': {
        _awaitingReleases = false;
        _orgInstanceUrl = msg.orgInstanceUrl || '';
        document.getElementById('modeCard').style.display = 'block';
        document.getElementById('orgDot').classList.add('on');
        _releases = msg.releases;
        _pipelines = msg.pipelines || [];
        if (!_pipelines.some(p => p.name === _pipelineName)) {
          const active = _pipelines.filter(p => p.active);
          _pipelineName = active.length === 1 ? active[0].name : '';
        }
        renderPipelines();
        onPipelinePick((_pipelines.find(p => p.name === _pipelineName) || {}).id || '');
        _picked.promote = [];
        _picked.future = [];
        renderReleasePickers();
        showStatus('Loaded ' + msg.releases.length + ' releases. Select releases and click Analyse.', 'success', false);
        break;
      }
      case 'pipelineEnvs': {
        const cur = _pipelines.find(p => p.name === _pipelineName);
        if (!cur || cur.id !== msg.pipelineId) break;
        _environments = msg.environments || [];
        renderEnvironments(false);
        break;
      }
      case 'results':
        if (_awaitingReleases) break;
        _orgInstanceUrl = msg.orgInstanceUrl || _orgInstanceUrl;
        document.getElementById('btnAnalyseReleases').disabled = false;
        document.getElementById('btnAnalyseStories').disabled = false;
        _run++;
        _touch.clear();
        _last = { components: msg.components, mode: msg.mode, envName: msg.envName || '', envStoryCount: msg.envStoryCount || 0, envOwnCount: msg.envOwnCount || 0, movedBackCount: msg.movedBackCount || 0 };
        renderEnvOptions(msg.components);
        refreshPrefsState();
        renderResults(msg.components, msg.mode);
        if (msg.components.length === 0) {
          showStatus('Analysis complete — no common components found.', 'success', false);
        } else {
          showStatus('Analysis complete — ' + msg.components.length + ' common components found. Expand each to view story diffs.', 'success', false);
        }
        break;
      case 'prTouch':
        if (msg.run !== _run) break;
        _touch.set(msg.key, { results: msg.results || {} });
        refreshTouchRows(msg.key);
        break;
      case 'progress':
        if (_awaitingReleases) break;
        showProgress(msg);
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
        _awaitingReleases = false;
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
  renderPipelines();
  renderEnvironments(false);
  setCompareBy(_compareBy);
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
    stopAllGit();
    ReleaseCheckerPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
