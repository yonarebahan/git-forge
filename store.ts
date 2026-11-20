import { GitStore, ZERO } from './git.ts';

export type Json = Record<string, any>;
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const need = (condition: unknown, status = 422, message = 'Validation Failed'): void => { if (!condition) throw new ApiError(status, message); };
export const gid = (type: string, repo: number, id = 0) => Buffer.from(`${type}:${repo}:${id}`).toString('base64');
export class Repository {
  id: number;
  name: string;
  description: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  git = new GitStore();
  issues = new Map<number, Json>();
  pulls = new Map<number, Json>();
  comments = new Map<number, Json[]>();
  labels = new Map<string, Json>();
  nextNumber = 1;
  nextComment = 1;
  constructor(id: number, input: Json, now: string) {
    this.id = id; this.name = input.name; this.description = input.description ?? '';
    this.private = input.private === true; this.created_at = this.updated_at = now;
  }
}
export class Store {
  // wire.ts binds the opaque bearer token to Scenario.viewer; it does not encode a login.
  owner = 'adaiversen';
  user = { login: this.owner, id: 1000, node_id: gid('User', 1000), type: 'User' };
  repos = new Map<string, Repository>();
  nextRepo = 1;
  clock = 0;
  now(): string { return new Date(1735689600000 + this.clock++ * 1000).toISOString(); }
  epoch(): number { return 1735689600 + this.clock++; }
  repo(owner: string, name: string): Repository {
    const repo = owner === this.owner ? this.repos.get(name) : undefined;
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }
  createRepo(input: Json): Repository {
    need(typeof input.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.name));
    need(!this.repos.has(input.name), 422, 'Repository already exists');
    const repo = new Repository(this.nextRepo++, input, this.now());
    this.repos.set(repo.name, repo);
    if (input.auto_init) this.contentWrite(repo, 'README.md', { content: Buffer.from(`# ${repo.name}\n`).toString('base64'), message: 'Initial commit' });
    return repo;
  }
  repoJson(repo: Repository): Json {
    return { id: repo.id, node_id: gid('Repository', repo.id), name: repo.name, full_name: `${this.owner}/${repo.name}`, owner: this.user,
      private: repo.private, description: repo.description, default_branch: repo.git.defaultBranch, has_issues: true,
      created_at: repo.created_at, updated_at: repo.updated_at };
  }
  issue(repo: Repository, number: number): Json {
    const issue = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!issue) throw new ApiError(404, 'Not Found');
    return issue;
  }
  createIssue(repo: Repository, input: Json): Json {
    need(typeof input.title === 'string' && input.title.length > 0);
    const labels = input.labels ?? [];
    need(Array.isArray(labels) && labels.every((name: string) => repo.labels.has(name)), 422, 'Unknown label');
    const number = repo.nextNumber++, now = this.now();
    const issue = { id: number, node_id: gid('Issue', repo.id, number), number, title: input.title, body: input.body ?? '', state: 'open',
      labels: labels.map((name: string) => repo.labels.get(name)), user: this.user, created_at: now, updated_at: now, closed_at: null, comments: 0 };
    repo.issues.set(number, issue);
    return issue;
  }
  updateIssue(repo: Repository, number: number, input: Json): Json {
    const issue = this.issue(repo, number);
    if (input.labels !== undefined) { need(Array.isArray(input.labels) && input.labels.every((x: string) => repo.labels.has(x)), 422, 'Unknown label'); issue.labels = input.labels.map((x: string) => repo.labels.get(x)); }
    for (const field of ['title', 'body']) if (typeof input[field] === 'string') issue[field] = input[field];
    if (input.state !== undefined) { need(['open', 'closed'].includes(input.state)); issue.state = input.state; issue.closed_at = input.state === 'closed' ? this.now() : null; }
    issue.updated_at = this.now();
    return issue;
  }
  listIssues(repo: Repository, state = 'open', direction = 'desc'): Json[] {
    return [...repo.issues.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
  }
  addComment(repo: Repository, number: number, body: string): Json {
    need(typeof body === 'string' && body.length > 0);
    const issue = this.issue(repo, number), id = repo.nextComment++, now = this.now();
    const comment = { id, node_id: gid('IssueComment', repo.id, id), body, user: this.user, created_at: now, updated_at: now };
    const comments = repo.comments.get(number) ?? []; comments.push(comment); repo.comments.set(number, comments);
    issue.comments = comments.length; issue.updated_at = now;
    return comment;
  }
  createPull(repo: Repository, input: Json): Json {
    need(typeof input.title === 'string' && input.title.length > 0 && typeof input.head === 'string' && typeof input.base === 'string');
    const head = input.head.includes(':') ? input.head.split(':').at(-1) : input.head;
    const headSha = repo.git.resolve(head), baseSha = repo.git.resolve(input.base);
    need(headSha && baseSha && head !== input.base, 422, 'Head and base must name distinct existing branches');
    const number = repo.nextNumber++, now = this.now();
    const pull = { id: number, node_id: gid('PullRequest', repo.id, number), number, title: input.title, body: input.body ?? '', state: 'open',
      head: { ref: head, sha: headSha, label: `${this.owner}:${head}` }, base: { ref: input.base, sha: baseSha, label: `${this.owner}:${input.base}` },
      user: this.user, labels: [], comments: 0, created_at: now, updated_at: now, closed_at: null, merged: false, merged_at: null, merge_commit_sha: null, draft: input.draft === true };
    repo.pulls.set(number, pull);
    return pull;
  }
  pull(repo: Repository, number: number): Json {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, 'Not Found');
    if (!pull.merged) {
      pull.head.sha = repo.git.resolve(pull.head.ref) ?? pull.head.sha;
      pull.base.sha = repo.git.resolve(pull.base.ref) ?? pull.base.sha;
    }
    return pull;
  }
  mergeBase(repo: Repository, left: string, right: string): string | undefined {
    const ancestors = repo.git.ancestors(left), queue = [right], seen = new Set<string>();
    for (let p = 0; p < queue.length; p++) {
      const id = queue[p]; if (ancestors.has(id)) return id;
      if (seen.has(id)) continue; seen.add(id); queue.push(...repo.git.commit(id).parents);
    }
    return undefined;
  }
  mergeFiles(repo: Repository, pull: Json) {
    const base = repo.git.files(pull.base.sha), head = repo.git.files(pull.head.sha);
    const ancestor = repo.git.files(this.mergeBase(repo, pull.base.sha, pull.head.sha));
    const merged = new Map(base); let conflict = false;
    const equal = (a: any, b: any) => a?.oid === b?.oid && a?.mode === b?.mode;
    for (const path of new Set([...ancestor.keys(), ...head.keys()])) {
      const original = ancestor.get(path), changed = head.get(path), current = base.get(path);
      if (equal(original, changed)) continue;
      if (!equal(current, original) && !equal(current, changed)) { conflict = true; continue; }
      if (changed) merged.set(path, changed); else merged.delete(path);
    }
    return { files: merged, conflict };
  }
  pullFiles(repo: Repository, pull: Json): Json[] {
    const before = repo.git.files(this.mergeBase(repo, pull.base.sha, pull.head.sha));
    const after = repo.git.files(pull.head.sha), result: Json[] = [];
    const lineCount = (id?: string) => id ? repo.git.objects.get(id)!.data.toString().split('\n').filter((_, i, a) => i < a.length - 1 || a[i] !== '').length : 0;
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(path), b = after.get(path);
      if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
      const additions = lineCount(b?.oid), deletions = lineCount(a?.oid);
      result.push({ sha: b?.oid ?? a?.oid, filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions });
    }
    return result;
  }
  mergePull(repo: Repository, number: number, input: Json = {}): Json {
    const pull = this.pull(repo, number);
    need(pull.state === 'open' && !pull.merged, 405, 'Pull request is not open');
    if (input.sha) need(input.sha === pull.head.sha, 409, 'Head SHA does not match');
    const merged = this.mergeFiles(repo, pull);
    need(!merged.conflict, 405, 'Pull request has merge conflicts');
    const sha = repo.git.makeCommit(merged.files, [pull.base.sha], input.commit_title ?? `${pull.title} (#${number})`, this.epoch(), `${this.owner} <${this.owner}@example.invalid>`);
    repo.git.refs.set(`refs/heads/${pull.base.ref}`, sha);
    const now = this.now(); Object.assign(pull, { state: 'closed', merged: true, merged_at: now, closed_at: now, updated_at: now, merge_commit_sha: sha });
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }
  content(repo: Repository, path: string, ref?: string): Json | Json[] {
    const oid = repo.git.resolve(ref), files = repo.git.files(oid);
    if (files.has(path)) {
      const file = files.get(path)!, data = repo.git.objects.get(file.oid)!.data;
      return { type: 'file', name: path.split('/').at(-1), path, sha: file.oid, size: data.length, encoding: 'base64', content: data.toString('base64') };
    }
    const prefix = path ? `${path.replace(/\/$/, '')}/` : '', entries = new Map<string, Json>();
    for (const [name, file] of files) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length), segment = suffix.split('/')[0], dir = suffix.includes('/');
      entries.set(segment, { name: segment, path: prefix + segment, type: dir ? 'dir' : 'file', sha: file.oid, size: dir ? 0 : repo.git.objects.get(file.oid)!.data.length });
    }
    if (!entries.size) throw new ApiError(404, 'Not Found');
    return [...entries.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  }
  contentWrite(repo: Repository, path: string, input: Json, remove = false) {
    need(path && !path.split('/').some(x => !x || x === '.' || x === '..'));
    need(typeof input.message === 'string' && (remove || typeof input.content === 'string'));
    const branch = input.branch ?? repo.git.defaultBranch, parent = repo.git.resolve(branch);
    if (input.branch && !parent) throw new ApiError(404, 'Branch not found');
    const files = repo.git.files(parent), old = files.get(path);
    if (remove && !old) throw new ApiError(404, 'Not Found');
    if (old) need(input.sha === old.oid, 409, 'SHA does not match');
    else need(!input.sha, 409, 'SHA does not match');
    if (remove) files.delete(path);
    else files.set(path, { oid: repo.git.put('blob', Buffer.from(input.content, 'base64')), mode: old?.mode ?? '100644' });
    const sha = repo.git.makeCommit(files, parent ? [parent] : [], input.message, this.epoch(), `${this.owner} <${this.owner}@example.invalid>`);
    repo.git.refs.set(`refs/heads/${branch}`, sha); repo.updated_at = this.now();
    return { status: remove || old ? 200 : 201, body: { content: remove ? null : this.content(repo, path, branch), commit: { sha, message: input.message } } };
  }
  node(id: string): { type: string; repo?: Repository; value: Json } | null {
    const [type, repoId, itemId] = Buffer.from(String(id), 'base64').toString().split(':');
    const repo = [...this.repos.values()].find(r => r.id === Number(repoId));
    if (!repo) return null;
    const value = type === 'Repository' ? this.repoJson(repo) : type === 'Issue' ? repo.issues.get(Number(itemId)) : type === 'PullRequest' ? repo.pulls.get(Number(itemId)) : undefined;
    return value ? { type, repo, value } : null;
  }
  rest(method: string, path: string, query: URLSearchParams, input: Json, origin: string): { status: number; body: any; headers?: Record<string, string> } {
    const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const answer = (body: any, status = 200) => ({ body, status });
    const page = (items: any[]) => {
      const limit = Math.min(100, Math.max(1, Number(query.get('per_page')) || 30)), n = Math.max(1, Number(query.get('page')) || 1);
      const headers: Record<string, string> = {};
      if (n * limit < items.length) { const next = new URL(origin + path); next.search = query.toString(); next.searchParams.set('page', String(n + 1)); headers.link = `<${next}>; rel="next"`; }
      return { status: 200, body: items.slice((n - 1) * limit, n * limit), headers };
    };
    if (!segments.length && method === 'GET') return { ...answer({ current_user_url: `${origin}/api/v3/user` }), headers: { 'x-oauth-scopes': 'repo, read:org' } };
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') return answer({ installed_version: 'git-forge/1.0' });
    if (segments[0] === 'user') {
      if (segments.length === 1 && method === 'GET') return answer(this.user);
      if (segments[1] === 'repos' && segments.length === 2) {
        if (method === 'POST') return answer(this.repoJson(this.createRepo(input)), 201);
        if (method === 'GET') return page([...this.repos.values()].map(r => this.repoJson(r)));
      }
    }
    if (segments[0] !== 'repos' || segments.length < 3) throw new ApiError(404, 'Not Found');
    const repo = this.repo(segments[1], segments[2]), tail = segments.slice(3), resource = tail[0];
    if (!tail.length) {
      if (method === 'GET') return answer(this.repoJson(repo));
      if (method === 'DELETE') { this.repos.delete(repo.name); return answer(null, 204); }
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string') { need(repo.git.resolve(input.default_branch)); repo.git.defaultBranch = input.default_branch; }
        repo.updated_at = this.now(); return answer(this.repoJson(repo));
      }
    }
    if (resource === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') return answer(this.content(repo, filePath, query.get('ref') ?? undefined));
      if (method === 'PUT' || method === 'DELETE') return this.contentWrite(repo, filePath, input, method === 'DELETE');
    }
    if (resource === 'branches' && method === 'GET') {
      const branches = [...repo.git.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false })).sort((a, b) => a.name < b.name ? -1 : 1);
      if (tail.length === 1) return page(branches);
      const branch = branches.find(x => x.name === tail.slice(1).join('/')); need(branch, 404, 'Not Found'); return answer(branch);
    }
    if (resource === 'git' && ['refs', 'ref'].includes(tail[1])) {
      if (tail.length === 2 && method === 'POST') {
        need(typeof input.ref === 'string' && input.ref.startsWith('refs/') && repo.git.objects.has(input.sha));
        need(!repo.git.refs.has(input.ref), 422, 'Reference already exists'); repo.git.refs.set(input.ref, input.sha);
        return answer({ ref: input.ref, object: { type: repo.git.objects.get(input.sha)!.type, sha: input.sha } }, 201);
      }
      const ref = `refs/${tail.slice(2).join('/')}`, sha = repo.git.refs.get(ref); need(sha, 404, 'Not Found');
      if (method === 'GET') return answer({ ref, object: { sha, type: repo.git.objects.get(sha!)?.type } });
      if (method === 'DELETE') { repo.git.refs.delete(ref); return answer(null, 204); }
      if (method === 'PATCH') { need(repo.git.objects.has(input.sha)); need(repo.git.isAncestor(sha!, input.sha), 409, 'non-fast-forward'); repo.git.refs.set(ref, input.sha); return answer({ ref, object: { sha: input.sha, type: 'commit' } }); }
    }
    if (resource === 'commits' && method === 'GET') {
      const ref = tail.length > 1 ? tail.slice(1).join('/') : query.get('sha') ?? repo.git.defaultBranch;
      const sha = repo.git.resolve(ref); if (!sha) return answer([]);
      const view = (id: string) => { const c = repo.git.commit(id); return { sha: id, commit: { message: c.message, tree: { sha: c.tree }, author: { name: c.author }, committer: { name: c.committer } }, parents: c.parents.map(sha => ({ sha })) }; };
      if (tail.length > 1) return answer(view(sha));
      return page([...repo.git.ancestors(sha)].map(view));
    }
    if (resource === 'labels' && tail.length === 1) {
      if (method === 'POST') { need(typeof input.name === 'string' && input.name.length); const label = { id: repo.labels.size + 1, name: input.name, color: input.color ?? 'ededed', description: input.description ?? '' }; repo.labels.set(input.name, label); return answer(label, 201); }
      if (method === 'GET') return page([...repo.labels.values()]);
    }
    if (resource === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return answer(this.createIssue(repo, input), 201);
        if (method === 'GET') return page(this.listIssues(repo, query.get('state') ?? 'open', query.get('direction') ?? 'desc'));
      }
      const number = Number(tail[1]); this.issue(repo, number);
      if (tail.length === 2) {
        if (method === 'GET') return answer(this.issue(repo, number));
        if (method === 'PATCH') return answer(this.updateIssue(repo, number, input));
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') return answer(this.addComment(repo, number, input.body), 201);
        if (method === 'GET') return page(repo.comments.get(number) ?? []);
      }
    }
    if (resource === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return answer(this.createPull(repo, input), 201);
        if (method === 'GET') { const state = query.get('state') ?? 'open'; return page([...repo.pulls.values()].filter(p => state === 'all' || p.state === state).sort((a, b) => b.number - a.number).map(p => this.pull(repo, p.number))); }
      }
      const pull = this.pull(repo, Number(tail[1]));
      if (tail.length === 2 && method === 'GET') return answer(pull);
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return page(this.pullFiles(repo, pull));
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return answer(this.mergePull(repo, pull.number, input));
    }
    throw new ApiError(404, 'Not Found');
  }
}
