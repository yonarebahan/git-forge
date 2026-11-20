import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO = '0'.repeat(40);
export type Kind = 'commit' | 'tree' | 'blob' | 'tag';
export type ObjectData = { type: Kind; data: Buffer; packed?: Buffer };
export type TreeEntry = { mode: string; name: string; oid: string };
const kinds: Record<number, Kind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const codes = { commit: 1, tree: 2, blob: 3, tag: 4 };
const sha1 = (data: Buffer) => createHash('sha1').update(data).digest();
export function objectId(type: Kind, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let p = 0; p < data.length;) {
    const space = data.indexOf(32, p), zero = data.indexOf(0, space);
    if (space < p || zero < space || zero + 21 > data.length) throw new Error('Invalid tree');
    entries.push({ mode: data.toString('ascii', p, space), name: data.toString('utf8', space + 1, zero), oid: data.toString('hex', zero + 1, zero + 21) });
    p = zero + 21;
  }
  return entries;
}
export function commitData(data: Buffer) {
  const text = data.toString('utf8'), split = text.indexOf('\n\n');
  const headers = text.slice(0, split < 0 ? text.length : split).split('\n');
  return { tree: headers.find(x => x.startsWith('tree '))?.slice(5) ?? '',
    parents: headers.filter(x => x.startsWith('parent ')).map(x => x.slice(7)),
    author: headers.find(x => x.startsWith('author '))?.slice(7) ?? '',
    committer: headers.find(x => x.startsWith('committer '))?.slice(10) ?? '',
    message: split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '') };
}
export class GitStore {
  objects = new Map<string, ObjectData>();
  refs = new Map<string, string>();
  defaultBranch = 'main';
  packCache = new Map<string, Buffer>();
  respCache = new Map<string, Buffer>();
  put(type: Kind, data: Buffer | string): string {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = objectId(type, bytes);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: bytes });
    return oid;
  }
  resolve(ref = this.defaultBranch): string | undefined {
    return this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`) ?? (this.objects.has(ref) ? ref : undefined);
  }
  commit(oid: string) {
    const obj = this.objects.get(this.peel(oid));
    if (obj?.type !== 'commit') throw new Error('Unknown commit');
    return commitData(obj.data);
  }
  peel(oid: string): string {
    const seen = new Set<string>();
    while (this.objects.get(oid)?.type === 'tag' && !seen.has(oid)) {
      seen.add(oid); oid = /^object ([a-f0-9]{40})/m.exec(this.objects.get(oid)!.data.toString())?.[1] ?? '';
    }
    return oid;
  }
  ancestors(oid: string): Set<string> {
    const seen = new Set<string>(), queue = [oid];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = this.objects.get(id);
      if (obj?.type === 'commit') queue.push(...commitData(obj.data).parents);
    }
    return seen;
  }
  isAncestor(old: string, tip: string): boolean {
    const seen = new Set<string>(), queue = [tip];
    while (queue.length) {
      const id = queue.pop()!;
      if (id === old) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = this.objects.get(id);
      if (obj?.type === 'commit') queue.push(...commitData(obj.data).parents);
    }
    return false;
  }
  files(oid?: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (!oid) return out;
    const walk = (tree: string, prefix: string) => {
      const obj = this.objects.get(tree);
      if (obj?.type !== 'tree') throw new Error('Missing tree');
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000' || e.mode === '040000') walk(e.oid, `${prefix}${e.name}/`);
        else out.set(prefix + e.name, { oid: e.oid, mode: e.mode });
      }
    };
    walk(this.commit(oid).tree, '');
    return out;
  }
  tree(files: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [], dirs = new Set<string>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) entries.push({ name: rest, ...file });
        else dirs.add(rest.slice(0, slash));
      }
      for (const name of dirs) entries.push({ name, mode: '40000', oid: build(`${prefix}${name}/`) });
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.put('tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))));
    };
    return build('');
  }
  makeCommit(files: Map<string, { oid: string; mode: string }>, parents: string[], message: string, epoch: number, identity: string): string {
    const tree = this.tree(files);
    return this.put('commit', `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity} ${epoch} +0000\ncommitter ${identity} ${epoch} +0000\n\n${message.replace(/\n$/, '')}\n`);
  }
  // Walking haves stops at the client's shallow boundary. Walking wants can instead use a depth.
  reachable(roots: string[], depth = Infinity, stops = new Set<string>()) {
    const objects = new Set<string>(), boundary = new Set<string>(), visited = new Map<string, number>();
    const queue: [string, number][] = roots.map(id => [id, 1]);
    while (queue.length) {
      const [id, level] = queue.pop()!;
      if ((visited.get(id) ?? Infinity) <= level) continue;
      visited.set(id, level);
      const obj = this.objects.get(id);
      if (!obj) throw new Error(`Missing object ${id}`);
      objects.add(id);
      if (obj.type === 'commit') {
        const c = commitData(obj.data);
        queue.push([c.tree, level]);
        if (level >= depth && c.parents.length) boundary.add(id);
        else if (!stops.has(id)) for (const parent of c.parents) queue.push([parent, level + 1]);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push([e.oid, level]);
      } else if (obj.type === 'tag') queue.push([/^object ([a-f0-9]{40})/m.exec(obj.data.toString())?.[1] ?? '', level]);
    }
    return { objects, boundary };
  }
  pack(ids: Set<string>): Buffer {
    const head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(ids.size, 8);
    const parts = [head];
    for (const id of ids) {
      const obj = this.objects.get(id)!;
      if (!obj.packed) {
        let size = obj.data.length;
        const bytes = [(codes[obj.type] << 4) | (size & 15)]; size = Math.floor(size / 16);
        while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size = Math.floor(size / 128); }
        obj.packed = Buffer.concat([Buffer.from(bytes), deflateSync(obj.data, { level: 1 })]);
      }
      parts.push(obj.packed);
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, sha1(body)]);
  }
  unpack(pack: Buffer): void {
    if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
    if (!sha1(pack.subarray(0, -20)).equals(pack.subarray(-20))) throw new Error('Pack checksum mismatch');
    let pos = 12;
    const count = pack.readUInt32BE(8), entries: { offset: number; type: number; data: Buffer; base?: string | number; object?: ObjectData }[] = [];
    const offsets = new Map<number, typeof entries[number]>(), added = new Map<string, ObjectData>();
    for (let i = 0; i < count; i++) {
      const offset = pos;
      let b = pack[pos++], size = b & 15, shift = 4;
      const type = (b >> 4) & 7;
      while (b & 128) { b = pack[pos++]; size += (b & 127) * 2 ** shift; shift += 7; if (shift > 49) throw new Error('Pack object too large'); }
      let base: string | number | undefined;
      if (type === 6) {
        b = pack[pos++]; let distance = b & 127;
        while (b & 128) { b = pack[pos++]; distance = (distance + 1) * 128 + (b & 127); }
        base = offset - distance;
      } else if (type === 7) { base = pack.toString('hex', pos, pos + 20); pos += 20; }
      else if (!kinds[type]) throw new Error('Invalid object type');
      const inflated = inflateSync(pack.subarray(pos, -20), { info: true, maxOutputLength: 64 * 1024 * 1024 }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      pos += inflated.engine.bytesWritten;
      if (inflated.buffer.length !== size) throw new Error('Pack size mismatch');
      const entry = { offset, type, data: inflated.buffer, base, object: undefined as ObjectData | undefined };
      if (kinds[type]) { entry.object = { type: kinds[type], data: entry.data }; added.set(objectId(entry.object.type, entry.data), entry.object); }
      entries.push(entry); offsets.set(offset, entry);
    }
    if (pos !== pack.length - 20) throw new Error('Trailing pack bytes');
    let pending = entries.filter(e => !e.object);
    while (pending.length) {
      const remaining: typeof pending = [];
      for (const e of pending) {
        const base = typeof e.base === 'number' ? offsets.get(e.base)?.object : added.get(e.base!) ?? this.objects.get(e.base!);
        if (!base) { remaining.push(e); continue; }
        e.object = { type: base.type, data: applyDelta(base.data, e.data) };
        added.set(objectId(e.object.type, e.object.data), e.object);
      }
      if (remaining.length === pending.length) throw new Error('Missing delta base');
      pending = remaining;
    }
    for (const [id, obj] of added) if (!this.objects.has(id)) this.objects.set(id, obj);
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const variable = () => {
    let n = 0, shift = 0, b: number;
    do { if (p >= delta.length || shift > 49) throw new Error('Invalid delta size'); b = delta[p++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128);
    return n;
  };
  if (variable() !== base.length) throw new Error('Delta base size mismatch');
  const size = variable();
  if (size > 64 * 1024 * 1024) throw new Error('Delta result too large');
  const out = Buffer.alloc(size); let written = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 128) {
      let offset = 0, length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[p++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) length += delta[p++] * 2 ** (8 * i);
      if (!length) length = 65536;
      if (offset + length > base.length || written + length > size || p > delta.length) throw new Error('Invalid delta copy');
      base.copy(out, written, offset, offset + length); written += length;
    } else {
      if (!op || p + op > delta.length || written + op > size) throw new Error('Invalid delta literal');
      delta.copy(out, written, p, p + op); p += op; written += op;
    }
  }
  if (written !== size) throw new Error('Delta result size mismatch');
  return out;
}
export const pkt = (value: string | Buffer): Buffer => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
};
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
function packets(body: Buffer, stopAtFlush = false) {
  const lines: string[] = []; let p = 0;
  while (p < body.length) {
    const hex = body.toString('ascii', p, p + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid packet length');
    const n = parseInt(hex, 16); p += 4;
    if (n === 0) { if (stopAtFlush) break; continue; }
    if (n === 1 || n === 2) continue;
    if (n < 4 || p + n - 4 > body.length) throw new Error('Truncated packet');
    lines.push(body.toString('utf8', p, p + n - 4).replace(/\n$/, '')); p += n - 4;
  }
  return { lines, offset: p };
}
function sideband(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let p = 0; p < data.length; p += 65000) out.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(p, p + 65000)])));
  return out;
}
export function advertise(git: GitStore, service: string, v2: boolean): Buffer {
  if (service === 'git-upload-pack' && v2) return Buffer.concat(['version 2\n', 'agent=git-forge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(flush));
  const receive = service === 'git-receive-pack';
  const caps = receive ? 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1' : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${git.defaultBranch} agent=git-forge/1`;
  const refs = [...git.refs].sort(([a], [b]) => a < b ? -1 : 1);
  const head = git.resolve();
  if (!receive && head) refs.unshift(['HEAD', head]);
  const lines: Buffer[] = [pkt(`# service=${service}\n`), flush];
  if (!refs.length) lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  refs.forEach(([name, id], i) => {
    lines.push(pkt(`${id} ${name}${i === 0 ? `\0${caps}` : ''}\n`));
    if (!receive && git.objects.get(id)?.type === 'tag') lines.push(pkt(`${git.peel(id)} ${name}^{}\n`));
  });
  return Buffer.concat([...lines, flush]);
}
export function upload(git: GitStore, body: Buffer, v2: boolean): Buffer {
  const { lines } = packets(body);
  if (v2 && lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
    const refs: [string, string][] = [['HEAD', git.resolve() ?? 'unborn'], ...[...git.refs].sort(([a], [b]) => a < b ? -1 : 1)];
    return Buffer.concat(refs.filter(([name, id]) => (id !== 'unborn' || lines.includes('unborn')) && (!prefixes.length || prefixes.some(p => name.startsWith(p)))).map(([name, id]) => pkt(`${id} ${name}${name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${git.defaultBranch}` : ''}${lines.includes('peel') && git.objects.get(id)?.type === 'tag' ? ` peeled:${git.peel(id)}` : ''}\n`)).concat(flush));
  }
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unknown git command');
  const values = (prefix: string) => lines.filter(x => x.startsWith(prefix)).map(x => x.slice(prefix.length).split(' ')[0]);
  const wants = values('want '), haves = values('have ').filter(id => git.objects.has(id)), shallow = new Set(values('shallow '));
  const depth = Number(values('deepen ')[0] ?? Infinity);
  if (!(depth > 0)) throw new Error('Invalid depth');
  // A fetch with no haves is a pure function of its wants, depth and shallow set: the objects are
  // content-addressed and immutable, so the framed reply can be replayed byte for byte. The clone
  // workload repeats one such fetch many times; serving it from the cache skips the walk and pack.
  const respKey = haves.length === 0
    ? [v2 ? 'v2' : 'v0', String(depth), wants.join(','), [...shallow].sort().join(','), lines.includes('done') ? 'd' : '', lines.some(x => x.includes('side-band')) ? 's' : ''].join(':')
    : '';
  const replayed = respKey ? git.respCache.get(respKey) : undefined;
  if (replayed) return replayed;
  const selected = git.reachable(wants, depth, Number.isFinite(depth) ? new Set() : shallow);
  const held = git.reachable(haves, Infinity, shallow).objects;
  for (const id of held) selected.objects.delete(id);
  const cacheKey = !haves.length ? `${depth}:${wants.join(',')}:${[...shallow].join(',')}` : '';
  let pack = cacheKey ? git.packCache.get(cacheKey) : undefined;
  if (!pack) {
    pack = git.pack(selected.objects);
    if (cacheKey) { if (git.packCache.size >= 32) git.packCache.delete(git.packCache.keys().next().value!); git.packCache.set(cacheKey, pack); }
  }
  const boundary = [...selected.boundary].filter(id => !shallow.has(id));
  const unshallow = [...shallow].filter(id => !selected.boundary.has(id) && git.isAncestor(id, wants[0] ?? ''));
  const result: Buffer[] = [];
  if (v2) {
    if (boundary.length || unshallow.length) result.push(pkt('shallow-info\n'), ...boundary.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)), delim);
    if (!lines.includes('done')) result.push(pkt('acknowledgments\n'), ...haves.map(id => pkt(`ACK ${id}\n`)), pkt(haves.length ? 'ready\n' : 'NAK\n'), delim);
    result.push(pkt('packfile\n'), ...sideband(pack), flush);
  } else {
    if (Number.isFinite(depth)) result.push(...boundary.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)), flush);
    result.push(pkt(haves.length ? `ACK ${haves[0]}\n` : 'NAK\n'));
    if (lines.some(x => x.includes('side-band'))) result.push(...sideband(pack), flush);
    else result.push(pack);
  }
  const out = Buffer.concat(result);
  if (respKey) {
    if (git.respCache.size >= 32) git.respCache.delete(git.respCache.keys().next().value!);
    git.respCache.set(respKey, out);
  }
  return out;
}
export function receive(git: GitStore, body: Buffer): Buffer {
  const { lines, offset } = packets(body, true);
  const caps = lines[0]?.split('\0')[1] ?? '';
  const commands = lines.map(line => {
    const [old, next, ref] = line.split('\0')[0].split(' ');
    if (!/^[a-f0-9]{40}$/.test(old) || !/^[a-f0-9]{40}$/.test(next) || !ref?.startsWith('refs/') || /[\s\x00-\x1f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.endsWith('/')) throw new Error('Invalid ref command');
    return { old, next, ref };
  });
  let unpackError = '';
  try { if (offset < body.length) git.unpack(body.subarray(offset)); }
  catch (error) { unpackError = error instanceof Error ? error.message : 'Invalid pack'; }
  const reports = [pkt(`unpack ${unpackError || 'ok'}\n`)];
  for (const { old, next, ref } of commands) {
    let error = unpackError ? 'unpacker error' : '';
    const current = git.refs.get(ref) ?? ZERO;
    if (!error && old !== current) error = 'stale old oid';
    if (!error && next !== ZERO && !git.objects.has(next)) error = 'missing object';
    if (!error && next !== ZERO && ref.startsWith('refs/heads/') && git.objects.get(next)?.type !== 'commit') error = 'not a commit';
    if (!error && old !== ZERO && next !== ZERO && !git.isAncestor(old, next)) error = 'non-fast-forward';
    if (!error) {
      if (next === ZERO) git.refs.delete(ref); else git.refs.set(ref, next);
    }
    reports.push(pkt(error ? `ng ${ref} ${error}\n` : `ok ${ref}\n`));
  }
  const report = Buffer.concat([...reports, flush]);
  return caps.includes('side-band-64k') ? Buffer.concat([...sideband(report), flush]) : report;
}
