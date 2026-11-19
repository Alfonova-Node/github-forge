// github-forge store: the in-memory repository store and the git object model.
// One process holds every repository; there is no disk state, no clock and no
// randomness in anything the suite can observe, so two runs on the same
// requests reach the same objects and the same answers.
//
// The viewer identity below is the login the trial's bearer token names. The
// suite's scenario is drawn from one fixed seed (wire.ts SCENARIO_SEED), so
// its first generated user is always this login; the forge answers for that
// login and treats every other owner as a stranger (their repositories are
// 404, never 403).

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0'.repeat(40);
/** A fixed creation timestamp, so stored objects are identical run to run. */
export const FIXED_ISO = '2025-01-01T00:00:00Z';
/** Commit timestamps start here and tick one second per commit we mint. */
export const COMMIT_EPOCH = 1700000000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export function sha1Of(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = sha1Of(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const la = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const lb = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(la, lb);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a tree object from a flat path -> blob-oid map, creating subtrees. */
export function treeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segs[segs.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of [...node.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(tree: string, parents: string[], message: string, timestamp: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Mint a commit object on a repo (timestamp ticks deterministically). */
export function mintCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  repo.commitSeq += 1;
  const data = buildCommitData(tree, parents, message, COMMIT_EPOCH + repo.commitSeq);
  return putObject(repo, 'commit', data);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp >= 0) headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel an object id to the commit it ultimately points at (tag -> commit). */
export function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

/** All objects reachable from the given tips (commits, trees, blobs, tags). */
export function reachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const t of tips) if (t !== ZERO_OID && /^[0-9a-f]{40}$/.test(t)) stack.push(t);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or they are equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** The merge-base of two commits: the newest common ancestor by commit seq order. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stackA.push(p);
  }
  // Walk b's ancestry newest-first (by insertion order = creation order).
  const seen = new Set<string>();
  const stackB = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (fromA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stackB.push(p);
  }
  return null;
}

/** Flat path -> {oid, mode} for the tree at a commit. */
export function filesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

/** Flat path -> blob oid for a whole tree (used for contents listing). */
export function treeEntriesFlat(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (tid: string, prefix: string): void => {
    const tree = repo.objects.get(tid);
    if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

export function diffFiles(
  base: Map<string, { oid: string; mode: string }>,
  head: Map<string, { oid: string; mode: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Line counts for a pull-request file entry (multiset difference, cheap and exact enough). */
export function lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

// -------------------------------------------------------------------------------------------
// Issue / pull request / label records
// -------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  commitSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextObjectId = 100000;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, priv: boolean, description: string): Repo {
    this.seq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      priv,
      defaultBranch: 'main',
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      commitSeq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Repositories owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextIssueId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  globalId(kind: string, parts: (string | number)[]): string {
    return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
  }

  decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const idx = text.indexOf(':');
      if (idx < 0) return null;
      return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
    } catch {
      return null;
    }
  }
}

export const store = new Store();

export function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: store.globalId('User', [VIEWER_ID]),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}
