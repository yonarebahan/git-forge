import { Store, Repository, ApiError, gid, type Json } from './store.ts';

type Field = { name: string; alias: string; args: Json; selection: Field[]; condition?: string; directives?: { name: string; args: Json }[] };
type Operation = { name: string; kind: string; selection: Field[]; defaults: Json };
// A small document parser, rather than matching operation names: aliases, fragments and variables
// work the same for all documents on the supported schema.
class Parser {
  tokens: string[];
  pos = 0;
  fragments = new Map<string, Field>();
  constructor(source: string) {
    this.tokens = [];
    const pattern = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[!$():=@\[\]{|}]/gy;
    let offset = 0;
    while (offset < source.length) {
      pattern.lastIndex = offset; const match = pattern.exec(source);
      if (!match) throw new Error(`Unexpected GraphQL token at ${offset}`);
      offset = pattern.lastIndex;
      if (!/^(\s|#|,)/.test(match[0])) this.tokens.push(match[0]);
    }
  }
  peek() { return this.tokens[this.pos]; }
  take(expected?: string): string {
    const token = this.tokens[this.pos++];
    if (token === undefined || (expected && token !== expected)) throw new Error(`Expected ${expected ?? 'token'}, found ${token ?? 'end of document'}`);
    return token;
  }
  value(): any {
    const token = this.take();
    if (token === '$') return { variable: this.take() };
    if (token === '[') { const out = []; while (this.peek() !== ']') out.push(this.value()); this.take(']'); return out; }
    if (token === '{') { const out: Json = {}; while (this.peek() !== '}') { const key = this.take(); this.take(':'); out[key] = this.value(); } this.take('}'); return out; }
    if (token[0] === '"') return JSON.parse(token);
    if (token === 'null') return null;
    if (token === 'true' || token === 'false') return token === 'true';
    if (/^-?\d/.test(token)) return Number(token);
    return token;
  }
  args(): Json {
    const args: Json = {};
    if (this.peek() !== '(') return args;
    this.take('(');
    while (this.peek() !== ')') { const name = this.take(); this.take(':'); args[name] = this.value(); }
    this.take(')'); return args;
  }
  selection(): Field[] {
    this.take('{'); const fields: Field[] = [];
    while (this.peek() !== '}') {
      let name = this.take(), alias = name, condition: string | undefined;
      if (name === '...') {
        const fragment = this.take();
        if (fragment === 'on') { name = '...'; condition = this.take(); }
        else name = `...${fragment}`;
      } else if (this.peek() === ':') { this.take(':'); name = this.take(); }
      const args = this.args(), directives: { name: string; args: Json }[] = [];
      while (this.peek() === '@') { this.take(); directives.push({ name: this.take(), args: this.args() }); }
      const selection = this.peek() === '{' ? this.selection() : [];
      fields.push({ name, alias, args, selection, condition, directives });
    }
    this.take('}'); return fields;
  }
  document(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek()) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.take(); this.take('on'); const condition = this.take();
        this.fragments.set(name, { name: '...', alias: '', args: {}, condition, selection: this.selection() }); continue;
      }
      let kind = 'query', name = ''; const defaults: Json = {};
      if (this.peek() !== '{') {
        kind = this.take(); if (!['query', 'mutation'].includes(kind)) throw new Error(`Unsupported operation ${kind}`);
        if (this.peek() !== '{' && this.peek() !== '(') name = this.take();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.take('$'); const variable = this.take(); this.take(':');
            while (this.peek() && !['$', ')', '='].includes(this.peek())) this.take();
            if (this.peek() === '=') { this.take(); defaults[variable] = this.value(); }
          }
          this.take(')');
        }
      }
      operations.push({ kind, name, defaults, selection: this.selection() });
    }
    return operations;
  }
}
type ObjectView = { type: string; fields: Record<string, any> };
const view = (type: string, fields: Record<string, any>): ObjectView => ({ type, fields });
const schema: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'databaseId'],
};
const enums: Record<string, string[]> = { SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], OrderDirection: ['ASC', 'DESC'] };

export function graphql(store: Store, request: any): any {
  if (Array.isArray(request)) return request.map(item => graphql(store, item));
  try {
    if (typeof request?.query !== 'string') throw new Error('query must be a string');
    const parser = new Parser(request.query), operations = parser.document();
    const op = request.operationName ? operations.find(x => x.name === request.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!op) throw new Error('An operationName selecting one operation is required');
    const variables = { ...op.defaults, ...(request.variables ?? {}) };
    const values = (value: any): any => {
      if (Array.isArray(value)) return value.map(values);
      if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && typeof value.variable === 'string') return variables[value.variable];
        return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, values(val)]));
      }
      return value;
    };
    const user = () => view('User', { login: store.owner, id: gid('User', 1000), databaseId: 1000 });
    const connection = (type: string, items: any[], args: Json) => {
      const start = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':')[1]) : 0;
      const first = Math.min(100, Math.max(0, args.first ?? 30));
      if (!Number.isInteger(start) || start < 0) throw new Error('Invalid cursor');
      const page = items.slice(start, start + first), cursor = (index: number) => Buffer.from(`cursor:${index}`).toString('base64');
      return view(type, { totalCount: items.length, nodes: page, edges: page.map((node, i) => view('Edge', { node, cursor: cursor(start + i + 1) })),
        pageInfo: view('PageInfo', { hasNextPage: start + page.length < items.length, hasPreviousPage: start > 0, endCursor: page.length ? cursor(start + page.length) : null, startCursor: page.length ? cursor(start + 1) : null }) });
    };
    const issueView = (repo: Repository, issue: Json) => view('Issue', {
      id: issue.node_id, databaseId: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state.toUpperCase(), createdAt: issue.created_at, updatedAt: issue.updated_at, author: user(),
      comments: (args: Json) => connection('IssueCommentConnection', (repo.comments.get(issue.number) ?? []).map(c => view('IssueComment', { id: c.node_id, body: c.body })), args),
    });
    const pullView = (repo: Repository, pull: Json): ObjectView => {
      pull = store.pull(repo, pull.number);
      return view('PullRequest', { id: pull.node_id, databaseId: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.merged ? 'MERGED' : pull.state.toUpperCase(), merged: pull.merged,
        headRefName: pull.head.ref, baseRefName: pull.base.ref, createdAt: pull.created_at, updatedAt: pull.updated_at,
        mergeable: () => store.mergeFiles(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE',
        files: (args: Json) => connection('PullRequestChangedFileConnection', store.pullFiles(repo, pull).map(f => view('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })), args) });
    };
    const repoView = (repo: Repository): ObjectView => view('Repository', {
      id: gid('Repository', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${store.owner}/${repo.name}`, owner: user(),
      defaultBranchRef: repo.git.resolve() ? view('Ref', { name: repo.git.defaultBranch }) : null,
      viewerPermission: 'ADMIN', hasIssuesEnabled: true,
      issue: (args: Json) => repo.issues.has(args.number) ? issueView(repo, repo.issues.get(args.number)!) : null,
      issues: (args: Json) => {
        const direction = args.orderBy?.direction === 'DESC' ? 'desc' : 'asc';
        let items = store.listIssues(repo, 'all', direction);
        if (args.states) items = items.filter(i => args.states.includes(i.state.toUpperCase()));
        return connection('IssueConnection', items.map(i => issueView(repo, i)), args);
      },
      pullRequest: (args: Json) => repo.pulls.has(args.number) ? pullView(repo, repo.pulls.get(args.number)!) : null,
      pullRequests: (args: Json) => connection('PullRequestConnection', [...repo.pulls.values()].filter(p => !args.states || args.states.includes(p.merged ? 'MERGED' : p.state.toUpperCase())).sort((a, b) => a.number - b.number).map(p => pullView(repo, p)), args),
    });
    const nodeView = (id: string) => {
      const node = store.node(id);
      if (!node?.repo) return null;
      return node.type === 'Repository' ? repoView(node.repo) : node.type === 'Issue' ? issueView(node.repo, node.value) : pullView(node.repo, node.value);
    };
    const requireNode = (id: string, type?: string) => {
      const node = store.node(id);
      if (!node?.repo || (type && node.type !== type)) throw new Error('Could not resolve node');
      return node as { type: string; repo: Repository; value: Json };
    };
    const root = op.kind === 'mutation' ? view('Mutation', {
      createIssue: ({ input }: Json) => { const node = requireNode(input.repositoryId, 'Repository'); return view('CreateIssuePayload', { issue: issueView(node.repo, store.createIssue(node.repo, input)) }); },
      closeIssue: ({ input }: Json) => { const node = requireNode(input.issueId, 'Issue'); return view('CloseIssuePayload', { issue: issueView(node.repo, store.updateIssue(node.repo, node.value.number, { state: 'closed' })) }); },
      createPullRequest: ({ input }: Json) => { const node = requireNode(input.repositoryId, 'Repository'); return view('CreatePullRequestPayload', { pullRequest: pullView(node.repo, store.createPull(node.repo, { ...input, head: input.headRefName, base: input.baseRefName })) }); },
      mergePullRequest: ({ input }: Json) => { const node = requireNode(input.pullRequestId, 'PullRequest'); store.mergePull(node.repo, node.value.number); return view('MergePullRequestPayload', { pullRequest: pullView(node.repo, node.value) }); },
      addComment: ({ input }: Json) => { const node = requireNode(input.subjectId); const c = store.addComment(node.repo, node.value.number, input.body); return view('AddCommentPayload', { commentEdge: view('IssueCommentEdge', { node: view('IssueComment', { id: c.node_id, body: c.body }) }) }); },
    }) : view('Query', {
      viewer: user(),
      repository: ({ owner, name }: Json) => { try { return repoView(store.repo(owner, name)); } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; } },
      node: ({ id }: Json) => nodeView(id),
      __type: ({ name }: Json) => schema[name] || enums[name] ? view('__Type', { name, kind: enums[name] ? 'ENUM' : 'OBJECT',
        fields: schema[name]?.map(name => view('__Field', { name } )) ?? null,
        enumValues: enums[name]?.map(name => view('__EnumValue', { name })) ?? null }) : null,
    });
    const execute = (object: any, fields: Field[], depth = 0): any => {
      if (depth > 64) throw new Error('GraphQL selection is too deep');
      if (object === null || object === undefined) return null;
      if (Array.isArray(object)) return object.map(item => execute(item, fields, depth + 1));
      const output: Json = {};
      for (const field of fields) {
        if (field.directives?.some(d => d.name === 'skip' ? values(d.args).if === true : d.name === 'include' && values(d.args).if === false)) continue;
        if (field.name.startsWith('...')) {
          const fragment = field.name === '...' ? field : parser.fragments.get(field.name.slice(3));
          if (!fragment) throw new Error(`Unknown fragment ${field.name}`);
          if (!fragment.condition || fragment.condition === object.type || fragment.condition === 'Node') Object.assign(output, execute(object, fragment.selection, depth + 1));
          continue;
        }
        if (field.name === '__typename') { output[field.alias] = object.type; continue; }
        if (!Object.hasOwn(object.fields, field.name)) throw new Error(`Cannot query field "${field.name}" on type "${object.type}".`);
        let value = object.fields[field.name];
        if (typeof value === 'function') value = value(values(field.args));
        output[field.alias] = field.selection.length ? execute(value, field.selection, depth + 1) : value;
      }
      return output;
    };
    return { data: execute(root, op.selection) };
  } catch (error) { return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] }; }
}
