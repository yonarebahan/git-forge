import { Store, type Json } from './store.ts';

const definitions: [string, string, string[], Record<string, Json>][] = [
  ['create_repo', 'Create a repository owned by the authenticated user.', ['name'], { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }],
  ['get_repo', 'Read a repository and its stable identity.', ['owner', 'repo'], {}],
  ['create_issue', 'Open an issue in a repository.', ['owner', 'repo', 'title'], { title: { type: 'string' }, body: { type: 'string' } }],
  ['list_issues', 'List repository issues, optionally filtered by state.', ['owner', 'repo'], { state: { type: 'string', enum: ['open', 'closed', 'all'] } }],
  ['create_pull_request', 'Open a pull request between two existing branches.', ['owner', 'repo', 'title', 'head', 'base'], { title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }],
  ['merge_pull_request', 'Squash a conflict-free pull request into its base branch.', ['owner', 'repo', 'pull_number'], { pull_number: { type: 'integer' } }],
];
const tools = definitions.map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', properties: { ...(name === 'create_repo' ? {} : { owner: { type: 'string' }, repo: { type: 'string' } }), ...properties }, required } }));
const identity = { serverInfo: { name: 'git-forge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } };
export function rpcError(id: any, code: number, message: string) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
export function mcp(store: Store, request: any): any {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return rpcError(request?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = request;
  if (id === undefined && method.startsWith('notifications/')) return null;
  const reply = (result: any) => ({ jsonrpc: '2.0', id: id ?? null, result });
  if (method === 'server/discover') return reply({ ...identity, supportedVersions: ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'] });
  if (method === 'initialize') return reply({ ...identity, protocolVersion: ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25' });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
  const tool = tools.find(t => t.name === params.name);
  if (!tool) return rpcError(id, -32602, 'Unknown tool');
  const args = params.arguments ?? {};
  for (const name of tool.inputSchema.required) if (args[name] === undefined || args[name] === null || args[name] === '') return rpcError(id, -32602, `Missing required argument: ${name}`);
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (args[name] === undefined) continue;
    if (schema.type === 'integer' ? !Number.isInteger(args[name]) : typeof args[name] !== schema.type) return rpcError(id, -32602, `Invalid argument: ${name}`);
  }
  try {
    let result: any;
    if (tool.name === 'create_repo') result = store.repoJson(store.createRepo(args));
    else {
      const repo = store.repo(args.owner, args.repo);
      switch (tool.name) {
        case 'get_repo': result = store.repoJson(repo); break;
        case 'create_issue': result = store.createIssue(repo, args); break;
        case 'list_issues': result = store.listIssues(repo, args.state ?? 'open'); break;
        case 'create_pull_request': result = store.createPull(repo, args); break;
        case 'merge_pull_request': result = store.mergePull(repo, args.pull_number); break;
      }
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
  } catch (error) { return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }); }
}
