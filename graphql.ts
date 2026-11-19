// github-forge GraphQL v4: a small, purpose-built executor for the documents
// gh and github-mcp-server actually send. It parses the query text (aliases,
// variables, inline fragments, input objects, enums), validates field names
// against the schema, and resolves against the same store REST uses.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  diffFiles,
  filesAtCommit,
  mergeBase,
  mintCommit,
  store,
  treeFromFiles,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, mergeableOf, pullJson } from './rest.ts';

// -------------------------------------------------------------------------------------------
// Lexer / parser
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Map<string, { type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: null, variables: new Map(), selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        operations.push({ kind, name, variables, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelections() });
      } else {
        throw new Error(`unexpected token ${t.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Map<string, { type: string; defaultValue: ValueNode | null }> {
    const out = new Map<string, { type: string; defaultValue: ValueNode | null }>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseTypeName();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        out.set(name, { type, defaultValue });
      }
      this.expectPunct(')');
    }
    return out;
  }

  private parseTypeName(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseTypeName()}]`;
    } else {
      type = this.expectName();
    }
    while (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelections() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelections() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelections();
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Schema field tables (for validation and introspection)
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt',
  ],
  BranchRef: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'url', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'files', 'mergedAt', 'createdAt', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  GitObject: ['oid'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: { message: string; path?: (string | number)[] }[];
}

type ObjValue = { __typename: string; [key: string]: unknown };

function viewerObj(): ObjValue {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`, url: `/api/v3/users/${VIEWER_LOGIN}` };
}

function repoObj(repo: Repo): ObjValue {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: store.globalId('Repository', [repo.id]),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: viewerObj(),
    description: repo.description,
    private: repo.priv,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function issueObj(repo: Repo, issue: Issue): ObjValue {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: store.globalId('Issue', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: viewerObj(),
    createdAt: FIXED_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObj(repo: Repo, pull: Pull): ObjValue {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: store.globalId('PullRequest', [repo.id, pull.number]),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: mergeableOf(repo, pull),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    createdAt: FIXED_ISO,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function connection<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  toObj: (item: T) => ObjValue,
  typeName: string,
): ObjValue {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const afterNum = cursorNumber(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const nodes = page.map(toObj);
  return {
    __typename: typeName,
    nodes,
    edges: page.map((item, i) => ({ __typename: `${typeName.replace('Connection', '')}Edge`, node: nodes[i], cursor: cursorFor(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount: items.length,
  };
}

function orderedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => {
    if (a.createdSeq !== b.createdSeq) return (a.createdSeq - b.createdSeq) * direction;
    return (a.number - b.number) * direction;
  });
  return list;
}

function resolveField(
  parent: ObjValue,
  typeName: string,
  field: FieldNode,
  args: Record<string, unknown>,
  ctx: Ctx,
): unknown {
  const repo = parent._repo as Repo | undefined;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return viewerObj();
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const found = store.getRepo(owner, name);
        return found ? repoObj(found) : null;
      }
      if (field.name === 'node') {
        const decoded = store.decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const found = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
          return found ? repoObj(found) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
          const issue = found?.issues.find((i) => i.number === Number(decoded.parts[1]));
          return found && issue ? issueObj(found, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
          const pull = found?.pulls.find((p) => p.number === Number(decoded.parts[1]));
          return found && pull ? pullObj(found, pull) : null;
        }
        return null;
      }
      return undefined;
    }
    case 'Repository': {
      if (!repo) return undefined;
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return { __typename: 'BranchRef', name: repo.defaultBranch, target: { __typename: 'GitObject', oid: tip } };
      }
      if (field.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === args.number);
        return issue ? issueObj(repo, issue) : null;
      }
      if (field.name === 'issues') return connection(orderedIssues(repo, args), args, (i) => issueObj(repo, i), 'IssueConnection');
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === args.number);
        return pull ? pullObj(repo, pull) : null;
      }
      if (field.name === 'pullRequests') {
        let list = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((p) => wanted.has(p.state));
        }
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        return connection(list, args, (p) => pullObj(repo, p), 'PullRequestConnection');
      }
      return parent[field.name];
    }
    case 'Issue': {
      const issue = parent._issue as Issue | undefined;
      if (field.name === 'comments' && repo && issue) {
        const comments = repo.comments.get(issue.number) ?? [];
        return {
          __typename: 'IssueCommentConnection',
          nodes: comments.map((c) => ({ __typename: 'Comment', id: store.globalId('IssueComment', [repo.id, issue.number, c.id]), body: c.body, author: viewerObj(), createdAt: FIXED_ISO })),
          edges: [],
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: comments.length,
        };
      }
      return parent[field.name];
    }
    case 'PullRequest': {
      const pull = parent._pull as Pull | undefined;
      if (field.name === 'files' && repo && pull) {
        const base = mergeBase(repo, pull.headSha, pull.baseSha);
        const baseFiles = base ? filesAtCommit(repo, base) : new Map();
        const headFiles = filesAtCommit(repo, pull.headSha);
        const diffs = diffFiles(baseFiles, headFiles);
        const nodes = diffs.map((d, i) => {
          const oldData = d.oldOid ? repo.objects.get(d.oldOid)?.data ?? null : null;
          const newData = d.newOid ? repo.objects.get(d.newOid)?.data ?? null : null;
          const oldLines = oldData === null ? 0 : oldData.toString('utf8').split('\n').length;
          const newLines = newData === null ? 0 : newData.toString('utf8').split('\n').length;
          return { __typename: 'PullRequestFile', path: d.path, additions: newLines, deletions: oldLines, _n: i };
        });
        const first = typeof args.first === 'number' ? args.first : nodes.length;
        const page = nodes.slice(0, first);
        return {
          __typename: 'PullRequestFileConnection',
          nodes: page,
          edges: page.map((n) => ({ __typename: 'PullRequestFileEdge', node: n, cursor: cursorFor(n._n as number) })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: nodes.length,
        };
      }
      return parent[field.name];
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    default:
      return parent[field.name];
  }
}

function resolveMutation(field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const decoded = store.decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    store.seq += 1;
    const issue: Issue = {
      id: store.nextIssueId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      createdSeq: store.seq,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const decoded = store.decodeGlobalId(String(input.issueId ?? ''));
    const repo = decoded?.kind === 'Issue' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    issue.state = 'closed';
    issue.closedAt = FIXED_ISO;
    return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const decoded = store.decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'Repository' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: `Head or base branch does not exist: ${head} / ${base}` });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    store.seq += 1;
    const pull: Pull = {
      id: store.nextIssueId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdSeq: store.seq,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const decoded = store.decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = decoded?.kind === 'PullRequest' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
    if (!repo || !pull) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    if (mergeableOf(repo, pull) === 'CONFLICTING') {
      ctx.errors.push({ message: 'Pull request cannot be merged: merge conflict' });
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    const headFiles = filesAtCommit(repo, pull.headSha);
    const fileMap = new Map<string, string>();
    for (const [p, entry] of headFiles) fileMap.set(p, entry.oid);
    const treeOid = treeFromFiles(repo, fileMap);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const mergeSha = mintCommit(repo, treeOid, baseTip ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
  }
  if (field.name === 'addComment') {
    const decoded = store.decodeGlobalId(String(input.subjectId ?? ''));
    const repo = decoded?.kind === 'Issue' ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    store.seq += 1;
    const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), createdSeq: store.seq };
    repo.nextCommentId += 1;
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'Comment', id: store.globalId('IssueComment', [repo.id, issue.number, comment.id]), body: comment.body, author: viewerObj(), createdAt: FIXED_ISO },
        cursor: cursorFor(comment.id),
      },
      subject: issueObj(repo, issue),
    };
  }
  return undefined;
}

function typeOf(value: unknown): string {
  if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__typename);
  }
  return 'Query';
}

function resolveSelections(
  parent: unknown,
  typeName: string,
  selections: SelectionNode[],
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentObj = (parent !== null && typeof parent === 'object' ? (parent as ObjValue) : { __typename: typeName }) as ObjValue;
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) {
        if (frag.typeCondition === typeName || frag.typeCondition === 'Node') {
          Object.assign(out, resolveSelections(parent, typeName, frag.selections, ctx, path));
        }
      }
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, resolveSelections(parent, typeName, sel.selections, ctx, path));
      }
      continue;
    }
    const field = sel.field;
    const responseName = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseName] = typeName;
      continue;
    }
    if (field.name === '__type') {
      const args: Record<string, unknown> = {};
      for (const a of field.args) args[a.name] = valueOf(a.value, ctx.variables);
      out[responseName] = resolveTypeIntrospection(String(args.name ?? ''), field.selections, ctx);
      continue;
    }
    if (field.name === '__schema') {
      out[responseName] = resolveSchemaIntrospection(field.selections, ctx);
      continue;
    }
    const allowed = FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [...path, responseName] });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of field.args) args[a.name] = valueOf(a.value, ctx.variables);
    const value = resolveField(parentObj, typeName, field, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [...path, responseName] });
      continue;
    }
    out[responseName] = resolveValue(value, field.selections, ctx, [...path, responseName]);
  }
  return out;
}

function resolveValue(value: unknown, selections: SelectionNode[] | null, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) return value.map((v, i) => resolveValue(v, selections, ctx, [...path, i]));
  if (typeof value === 'object') {
    const typeName = typeOf(value);
    return resolveSelections(value, typeName, selections, ctx, path);
  }
  return value;
}

function resolveTypeIntrospection(name: string, selections: SelectionNode[] | null, ctx: Ctx): ObjValue | null {
  if (!name) return null;
  const fields = FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (!fields && !enumValues) return null;
  const value: ObjValue = {
    __typename: '__Type',
    name,
    kind: enumValues ? 'ENUM' : 'OBJECT',
    description: null,
    fields: fields ? fields.map((f) => ({ __typename: '__Field', name: f, description: null })) : null,
    enumValues: enumValues ? enumValues.map((e) => ({ __typename: '__EnumValue', name: e, description: null })) : null,
  };
  if (selections === null) return value;
  return resolveSelections(value, '__Type', selections, ctx, ['__type']) as unknown as ObjValue;
}

function resolveSchemaIntrospection(selections: SelectionNode[] | null, ctx: Ctx): ObjValue {
  const value: ObjValue = {
    __typename: '__Schema',
    types: Object.keys(FIELDS).map((name) => ({ __typename: '__Type', name, kind: 'OBJECT', description: null, fields: null, enumValues: null })),
    queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT', description: null, fields: null, enumValues: null },
    mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', description: null, fields: null, enumValues: null },
  };
  if (selections === null) return value;
  return resolveSelections(value, '__Schema', selections, ctx, ['__schema']) as unknown as ObjValue;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

export function executeGraphQL(query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const ctx: Ctx = { variables, fragments: new Map(), errors: [] };
  let doc: { operations: OperationNode[]; fragments: Map<string, FragmentDef> };
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = doc.fragments;
  let operation = doc.operations[0] ?? null;
  if (operationName) {
    operation = doc.operations.find((o) => o.name === operationName) ?? operation;
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation provided' }] };
  // Apply variable defaults.
  for (const [name, def] of operation.variables) {
    if (ctx.variables[name] === undefined && def.defaultValue !== null) {
      ctx.variables[name] = valueOf(def.defaultValue, {});
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: ObjValue = { __typename: rootType };
  const data = resolveSelections(root, rootType, operation.selections, ctx, []);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// Keep the REST shape import used (pullJson mirrors the REST view for parity).
void pullJson;
void issueJson;
