import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitStore, objectId } from '../git.ts';
import { Store, gid } from '../store.ts';
import { graphql } from '../graphql.ts';
import { mcp } from '../mcp.ts';

// Supply a directory of independently generated git packs to run this compatibility check.
// Keeping the oracle outside the process also works in environments that prohibit subprocesses.
test('real git REF_DELTA and OFS_DELTA packs round-trip through the object engine', { skip: !process.env.FORGE_PACK_FIXTURES }, () => {
  const dir = process.env.FORGE_PACK_FIXTURES!;
  const expected = JSON.parse(readFileSync(join(dir, 'objects.json'), 'utf8')) as Record<string, { type: string; data: string }>;
  for (const file of ['ref.pack', 'ofs.pack']) {
    const pack = readFileSync(join(dir, file)), store = new GitStore(); store.unpack(pack);
    assert.equal(store.objects.size, Object.keys(expected).length);
    for (const [id, fixture] of Object.entries(expected)) {
      const object = store.objects.get(id)!;
      assert.ok(object, id);
      assert.equal(object.type, fixture.type);
      assert.equal(objectId(object.type, object.data), id);
      assert.equal(object.data.toString('base64'), fixture.data);
    }
    const another = new GitStore(); another.unpack(store.pack(new Set(store.objects.keys())));
    assert.deepEqual([...another.objects.keys()].sort(), Object.keys(expected).sort());
    const corrupted = Buffer.from(pack); corrupted[20] ^= 1;
    const empty = new GitStore(); assert.throws(() => empty.unpack(corrupted), /checksum/); assert.equal(empty.objects.size, 0);
  }
});

test('squash preserves independent base changes and rejects conflicting edits without moving refs', () => {
  const store = new Store(), repo = store.createRepo({ name: 'merge' });
  const put = (path: string, text: string, branch?: string, sha?: string) => store.contentWrite(repo, path, { message: 'edit', content: Buffer.from(text).toString('base64'), branch, sha });
  const initial = put('shared.txt', 'original\n');
  repo.git.refs.set('refs/heads/feature', initial.body.commit.sha);
  put('feature.txt', 'feature\n', 'feature');
  put('base.txt', 'base\n');
  const pull = store.createPull(repo, { title: 'independent change', head: 'feature', base: 'main' });
  const merged = store.mergePull(repo, pull.number);
  const files = repo.git.files(merged.sha);
  assert.deepEqual([...files.keys()].sort(), ['base.txt', 'feature.txt', 'shared.txt']);
  assert.equal(repo.git.commit(merged.sha).parents.length, 1);
  const sha = (store.content(repo, 'shared.txt') as any).sha;
  repo.git.refs.set('refs/heads/conflict', merged.sha);
  put('shared.txt', 'feature side\n', 'conflict', sha);
  put('shared.txt', 'base side\n', 'main', sha);
  const conflicted = store.createPull(repo, { title: 'conflict', head: 'conflict', base: 'main' });
  const before = repo.git.resolve();
  assert.throws(() => store.mergePull(repo, conflicted.number), /conflict/);
  assert.equal(repo.git.resolve(), before);
  assert.equal(conflicted.state, 'open');
});

test('GraphQL aliases, named fragments and variables retain shared MCP identities', () => {
  const store = new Store(), repo = store.createRepo({ name: 'shared' });
  const call = mcp(store, { jsonrpc: '2.0', id: 'request-A', method: 'tools/call', params: { name: 'create_issue', arguments: { owner: store.owner, repo: repo.name, title: 'one' } } });
  assert.equal(call.id, 'request-A');
  const issue = JSON.parse(call.result.content[0].text);
  const result = graphql(store, { query: `query Read($id: ID!) { item: node(id: $id) { ...Details } } fragment Details on Issue { id number title }`, variables: { id: gid('Issue', repo.id, issue.number) } });
  assert.deepEqual(result, { data: { item: { id: issue.node_id, number: issue.number, title: 'one' } } });
  assert.match(graphql(store, { query: '{ viewer { absentField } }' }).errors[0].message, /absentField/);
  assert.equal(mcp(store, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_issue', arguments: {} } }).error.code, -32602);
});

test('logical timestamps and object identities are repeatable across independent stores', () => {
  const scenario = () => {
    const store = new Store(), repo = store.createRepo({ name: 'determinism' });
    store.contentWrite(repo, 'a.txt', { message: 'first', content: 'YQo=' });
    const issue = store.createIssue(repo, { title: 'deterministic' });
    store.updateIssue(repo, issue.number, { state: 'closed' });
    return JSON.stringify({ repo: store.repoJson(repo), issue, refs: [...repo.git.refs], objects: [...repo.git.objects].map(([id, object]) => [id, object.type, object.data.toString('base64')]) });
  };
  assert.equal(scenario(), scenario());
});
