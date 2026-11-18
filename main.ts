// Forge — a standalone GitHub-compatible forge in one Node.js process, standard library only.
//
// Surfaces, all over one in-memory store:
//   - git smart HTTP: protocol v2 (ls-refs, fetch incl. shallow) and v0 (fetch, receive-pack)
//   - REST v3 subset under /api/v3 (repos, contents, refs, branches, commits, labels, issues, pulls)
//   - GraphQL v4 subset at /api/graphql (queries, mutations, introspection, batching, node ids)
//   - MCP (Model Context Protocol) at /mcp: server/discover (2026-07-28) plus the legacy
//     initialize handshake, and a broad tool surface over the same store.
//
// Lifecycle (the make.fun entry contract): listen on an ephemeral port, POST the port to
// $MAKEFUN_ENV_URL/register, then poll $MAKEFUN_ENV_URL/done until the trial is over.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const GIT_AGENT = 'forge/1.0.0';

interface GitObject {
  type: string; // commit | tree | blob | tag
  data: Buffer;
}

interface CommentRec {
  id: number;
  body: string;
}

interface IssueRec {
  __gqlType: string; // 'Issue' | 'PullRequest'
  id: number; // global REST id, stable
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number; // creation order inside the repo
  isPR: boolean;
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  _json: string | null; // cached REST serialization
}

interface Repo {
  __gqlType: string;
  id: number;
  name: string;
  description: string;
  priv: boolean;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  headRef: string; // refs/heads/<default>
  issues: Map<number, IssueRec>;
  nextIssueNumber: number;
  labels: Map<string, { name: string; color: string }>;
  _json: string | null;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let issueSeq = 0;

/** The login the forge is bound to: the first owner that touches an existing repo wins. */
let boundLogin: string | null = null;
/** The trial's bearer token: the first token presented owns the forge. */
let ownerToken: string | null = process.env.MAKEFUN_SHOP_TOKEN || null;

// A logical clock keeps every timestamp the forge emits deterministic for a given
// request sequence (no wall-clock leakage into stored state).
let clockSec = 1_704_067_200; // 2024-01-01T00:00:00Z
function nowIso(): string {
  clockSec += 1;
  return new Date(clockSec * 1000).toISOString();
}

function newRepo(name: string, description: string, priv: boolean): Repo {
  const repo: Repo = {
    __gqlType: 'Repository',
    id: nextRepoId++,
    name,
    description,
    priv,
    objects: new Map(),
    refs: new Map(),
    headRef: 'refs/heads/main',
    issues: new Map(),
    nextIssueNumber: 1,
    labels: new Map(),
    _json: null,
  };
  repos.set(name, repo);
  return repo;
}

/** Look a repo up by owner/name, applying the single-user binding. Null when not visible. */
function lookupRepo(owner: string, name: string): Repo | null {
  const repo = repos.get(name);
  if (!repo) return null;
  if (boundLogin === null) {
    boundLogin = owner;
    return repo;
  }
  return owner === boundLogin ? repo : null;
}

function defaultBranchOf(repo: Repo): string {
  return repo.headRef.replace('refs/heads/', '');
}

function ownerLogin(): string {
  return boundLogin ?? 'viewer';
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64encode([kind, ...parts].join(':'));
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

function storeObject(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  let author = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
  }
  return { tree, parents, message, author };
}

function buildCommitData(tree: string, parents: string[], message: string): Buffer {
  const stamp = clockSec + 1;
  const ident = `Forge <forge@localhost> ${stamp} +0000`;
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
function treeToFlat(repo: Repo, treeOid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') treeToFlat(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

function flatOfCommit(repo: Repo, commitOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  if (!commitOid) return out;
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  treeToFlat(repo, parseCommit(obj.data).tree, '', out);
  return out;
}

/** Rebuild nested trees from a flat path map; returns the root tree oid. */
function flatToTree(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], value);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return emit(root);
}

/** Add a tree and everything under it to a set of oids. */
function addTreeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, into);
    else if (entry.mode !== '160000') into.add(entry.oid);
  }
}

/** Every object reachable from the tips (commits walk to trees and parents, tags to targets). */
function reachable(repo: Repo, tips: Iterable<string>, allowMissing: boolean): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) {
      if (!allowMissing) throw new Error(`missing object ${oid}`);
      continue;
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (entry.mode !== '160000') stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match) stack.push(match[1]);
    }
  }
  return seen;
}

/** The objects a shallow fetch at `depth` delivers, plus the boundary commits. */
function shallowSet(repo: Repo, wants: string[], depth: number): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  let frontier = [...wants];
  const seenCommits = new Set<string>();
  let level = 0;
  while (frontier.length > 0 && level < depth) {
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        objects.add(oid);
        const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (match) frontier.push(match[1]);
        continue;
      }
      if (obj.type !== 'commit') {
        objects.add(oid);
        continue;
      }
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      objects.add(oid);
      const commit = parseCommit(obj.data);
      addTreeClosure(repo, commit.tree, objects);
      if (level === depth - 1) boundary.add(oid);
      else next.push(...commit.parents);
    }
    frontier = next;
    level += 1;
  }
  return { objects, boundary };
}

/** What a client holding a depth-1 shallow clone already has: the tips and their trees. */
function shallowHeld(repo: Repo, tips: string[]): Set<string> {
  const held = new Set<string>();
  for (const oid of tips) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') addTreeClosure(repo, parseCommit(obj.data).tree, held);
    else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match) held.add(match[1]);
    }
  }
  return held;
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits (breadth-first from both sides). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const depth = new Map<string, number>();
    let frontier = [tip];
    let d = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (depth.has(oid)) continue;
        depth.set(oid, d);
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit') next.push(...parseCommit(obj.data).parents);
      }
      frontier = next;
      d += 1;
    }
    return depth;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, d] of fromA) {
    const other = fromB.get(oid);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = oid;
    }
  }
  return best;
}

/** Commits reachable from `tip` but not from `exclude`, newest first. */
function commitsSince(repo: Repo, tip: string, exclude: string | null): string[] {
  const excluded = exclude ? reachable(repo, [exclude], true) : new Set<string>();
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    stack.push(...parseCommit(obj.data).parents);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with a valid SHA-1 trailer. */
function buildPack(objects: { type: string; data: Buffer }[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  return out;
}

/** Read a packfile and resolve every object, including OFS/REF deltas. */
function readPack(buffer: Buffer): { type: string; data: Buffer; oid: string }[] {
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: { type: string; data: Buffer; oid: string };
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let byte = buffer[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = buffer[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset++];
        value = ((value + 1) * 128) + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const byOid = new Map<string, Raw>();
  const resolve = (entry: Raw): { type: string; data: Buffer; oid: string } => {
    if (entry.resolved) return entry.resolved;
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid as string);
      if (!baseEntry) throw new Error('ref-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const resolved = { type, data, oid: hashObject(type, data) };
    entry.resolved = resolved;
    byOid.set(resolved.oid, entry);
    return resolved;
  };
  return raw.map(resolve);
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of a buffer; returns the packets and the unparsed rest. */
function parsePkts(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
    if (packets[packets.length - 1].kind === 'flush') break;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Split a request body into its pkt-line sections (v2 commands end sections with a delim). */
function pktSections(buffer: Buffer): { sections: Buffer[][]; rest: Buffer } {
  const sections: Buffer[][] = [];
  let current: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      sections.push(current);
      current = [];
      offset += 4;
      return { sections, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      sections.push(current);
      current = [];
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      return { sections, rest: buffer.subarray(offset) };
    }
    if (length < 4 || offset + length > buffer.length) break;
    current.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (current.length > 0) sections.push(current);
  return { sections, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

/** Resolve a ref's target through annotated tags to the commit it names. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard++) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!match) return current;
    current = match[1];
  }
  return current;
}

/** Ref lines for an advertisement or ls-refs: HEAD first, then refs in name order. */
function advertisedRefs(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const out: { oid: string; name: string; peeled?: string }[] = [];
  const headOid = repo.refs.get(repo.headRef);
  if (headOid) out.push({ oid: headOid, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (obj && obj.type === 'tag') entry.peeled = peelToCommit(repo, oid);
    out.push(entry);
  }
  return out;
}

function handleInfoRefs(repo: Repo, service: string, isV2: boolean, res: ServerResponse): void {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && isV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${GIT_AGENT}\n`),
      pktLine('ls-refs\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'Content-Type': contentType, 'X-GitHub-Request-Id': nextRequestId() });
    res.end(body);
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:${repo.headRef} agent=${GIT_AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${GIT_AGENT}`;
  const refs = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled && ref.peeled !== ref.oid) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': contentType, 'X-GitHub-Request-Id': nextRequestId() });
  res.end(Buffer.concat(parts));
}

/** Frame pack bytes as sideband band-1 packets, each within the 65520-byte limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65_000;
  if (pack.length === 0) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return out;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/**
 * Fetch plans are pure functions of the request and the object graph, and the graph is
 * append-only (objects are content-addressed, refs only change which oids get named) —
 * so a computed pack stays valid for its request signature forever. Cache the last few
 * dozen: a burst of identical shallow clones then builds its pack exactly once.
 */
const packCache = new Map<string, { pack: Buffer; shallowLines: string[] }>();

/** Compute the pack and shallow lines a fetch request earns. */
function planFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallowLines: string[] } {
  const cacheKey = `${repo.name}|${plan.wants.join(',')}|${plan.haves.join(',')}|${plan.shallow.join(',')}|${plan.depth}`;
  const cached = packCache.get(cacheKey);
  if (cached) return cached;
  const result = computeFetch(repo, plan);
  if (packCache.size >= 64) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(cacheKey, result);
  return result;
}

function computeFetch(repo: Repo, plan: FetchPlan): { pack: Buffer; shallowLines: string[] } {
  let objects: Set<string>;
  const shallowLines: string[] = [];
  if (plan.depth !== null) {
    const shallow = shallowSet(repo, plan.wants, plan.depth);
    objects = shallow.objects;
    if (plan.shallow.length > 0) {
      const held = shallowHeld(repo, plan.shallow);
      for (const oid of held) objects.delete(oid);
    }
    if (plan.haves.length > 0) {
      // In a shallow fetch a "have" names a commit the client holds shallowly (itself
      // plus its tree), not its whole ancestry — subtracting the full closure would
      // eat the very parents a deepen request asks for.
      const held = shallowHeld(repo, plan.haves);
      for (const oid of held) objects.delete(oid);
    }
    for (const oid of shallow.boundary) shallowLines.push(`shallow ${oid}`);
  } else {
    objects = reachable(repo, plan.wants, false);
    if (plan.haves.length > 0 || plan.shallow.length > 0) {
      const exclude = reachable(repo, [...plan.haves, ...plan.shallow], true);
      for (const oid of exclude) objects.delete(oid);
    }
  }
  const list = [...objects].map((oid) => {
    const obj = repo.objects.get(oid) as GitObject;
    return { type: obj.type, data: obj.data };
  });
  // Commits first, then trees, then blobs: a stable, cache-friendly order.
  const rank: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  list.sort((a, b) => rank[a.type] - rank[b.type]);
  return { pack: buildPack(list), shallowLines };
}

function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { sections } = pktSections(body);
  const commandLines = (sections[0] ?? []).map((line) => line.toString('utf8').replace(/\n$/, ''));
  const command = commandLines.find((line) => line.startsWith('command='));
  const argLines = sections.flatMap((section) => section.map((line) => line.toString('utf8').replace(/\n$/, '')));
  if (command === 'command=ls-refs') {
    const wantPeel = argLines.includes('peel');
    const wantSymrefs = argLines.includes('symrefs');
    const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const parts: Buffer[] = [];
    for (const ref of advertisedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && wantSymrefs) line += ` symref-target:${repo.headRef}`;
      if (ref.peeled && ref.peeled !== ref.oid && wantPeel) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(PKT_FLUSH);
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': nextRequestId() });
    res.end(Buffer.concat(parts));
    return;
  }
  if (command === 'command=fetch') {
    const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of argLines) {
      if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7).trim(), 10);
    }
    const { pack, shallowLines } = planFetch(repo, plan);
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const common = plan.haves.filter((oid) => repo.objects.has(oid));
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(PKT_FLUSH);
    if (shallowLines.length > 0 || plan.depth !== null) {
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': nextRequestId() });
    res.end(Buffer.concat(parts));
    return;
  }
  res.writeHead(400, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': nextRequestId() });
  res.end('unsupported command');
}

function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { sections } = pktSections(body);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], depth: null };
  const all = sections.flatMap((section) => section.map((line) => line.toString('utf8').replace(/\n$/, '')));
  for (const line of all) {
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7).trim(), 10);
  }
  const { pack, shallowLines } = planFetch(repo, plan);
  const parts: Buffer[] = [];
  for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': nextRequestId() });
  res.end(Buffer.concat(parts));
}

interface PushCommandRec {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, rest } = parsePkts(body);
  const commands: PushCommandRec[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const object of objects) {
        if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    } catch {
      unpackOk = false;
    }
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === null) lines.push(`ng ${command.ref} reference does not exist\n`);
      else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current === null) {
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      lines.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    if (current === command.newOid || isAncestor(repo, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}\n`);
    } else {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }
  const report = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  let payload: Buffer;
  if (useSideband) {
    const banded = Buffer.concat([Buffer.from([1]), report]);
    payload = Buffer.concat([pktLine(banded), PKT_FLUSH]);
  } else {
    payload = report;
  }
  repo._json = null;
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'X-GitHub-Request-Id': nextRequestId() });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Issues, pull requests, merges (shared by REST, GraphQL and MCP)
// ---------------------------------------------------------------------------

function createIssueRec(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    __gqlType: 'Issue',
    id: nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: issueSeq++,
    isPR: false,
    headRef: '',
    baseRef: '',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    _json: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullRec(repo: Repo, title: string, body: string, headRef: string, baseRef: string): IssueRec {
  const pull = createIssueRec(repo, title, body, []);
  pull.isPR = true;
  pull.__gqlType = 'PullRequest';
  pull.headRef = headRef;
  pull.baseRef = baseRef;
  return pull;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return lines;
}

/** The file-level diff between two commits (either may be null). */
function diffFiles(repo: Repo, baseTip: string | null, headTip: string | null): FileChange[] {
  const base = flatOfCommit(repo, baseTip);
  const head = flatOfCommit(repo, headTip);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      changes.push({ filename: path, status: 'added', additions: countLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)), deletions: 0 });
    } else if (before && !after) {
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: countLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)) });
    } else if (before && after) {
      changes.push({
        filename: path,
        status: 'modified',
        additions: countLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)),
        deletions: countLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)),
      });
    }
  }
  return changes;
}

/** Three-way path merge; returns the merged flat map, or null on conflict. */
function threeWayMerge(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const out = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    let winner: string | null;
    if (o === t) winner = o;
    else if (b === o) winner = t;
    else if (b === t) winner = o;
    else return null;
    if (winner !== null) {
      const source = ours.get(path) ?? theirs.get(path) ?? base.get(path);
      out.set(path, { mode: source?.mode ?? '100644', oid: winner });
    }
  }
  return out;
}

function pullMergeable(repo: Repo, pull: IssueRec): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return 'CONFLICTING';
  if (isAncestor(repo, headTip, baseTip)) return 'MERGEABLE'; // already up to date
  const base = mergeBase(repo, baseTip, headTip);
  const merged = threeWayMerge(flatOfCommit(repo, base), flatOfCommit(repo, baseTip), flatOfCommit(repo, headTip));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Merge a pull request into its base branch. Returns the merge commit sha, or null on conflict. */
function mergePull(repo: Repo, pull: IssueRec, method: 'merge' | 'squash' | 'rebase'): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return null;
  const ancestor = mergeBase(repo, baseTip, headTip);
  const mergedFlat = threeWayMerge(flatOfCommit(repo, ancestor), flatOfCommit(repo, baseTip), flatOfCommit(repo, headTip));
  if (mergedFlat === null) return null;
  const tree = flatToTree(repo, mergedFlat);
  let commit: string;
  if (method === 'merge') {
    commit = storeObject(repo, 'commit', buildCommitData(tree, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`));
  } else if (method === 'squash') {
    commit = storeObject(repo, 'commit', buildCommitData(tree, [baseTip], `${pull.title} (#${pull.number})`));
  } else {
    commit = storeObject(repo, 'commit', buildCommitData(tree, [baseTip], pull.title));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commit;
  pull._json = null;
  repo._json = null;
  return commit;
}

/** Write (or delete, with null content) a file on a branch, creating a commit. */
function putFileContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null; created: boolean } | null {
  let tip = branchTip(repo, branch);
  if (!tip) {
    // A contents write creates the branch from the default branch when it can.
    tip = branchTip(repo, defaultBranchOf(repo));
    if (tip) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const flat = flatOfCommit(repo, tip);
  const existing = flat.get(path);
  let blobSha: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobSha = storeObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', oid: blobSha });
  }
  const tree = flatToTree(repo, flat);
  const parents = tip ? [tip] : [];
  const commit = storeObject(repo, 'commit', buildCommitData(tree, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo._json = null;
  return { commitSha: commit, blobSha, created: !existing };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const login = ownerLogin();
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.priv,
    description: repo.description,
    fork: false,
    default_branch: defaultBranchOf(repo),
    visibility: repo.priv ? 'private' : 'public',
    html_url: `http://forge.local/${login}/${repo.name}`,
  };
}

function repoJsonCached(repo: Repo): string {
  if (repo._json === null) repo._json = JSON.stringify(repoJson(repo));
  return repo._json;
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  const login = ownerLogin();
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: globalId(issue.isPR ? 'PullRequest' : 'Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(1_704_067_200_000 + issue.seq * 1000).toISOString(),
    updated_at: new Date(1_704_067_200_000 + issue.seq * 1000).toISOString(),
    closed_at: issue.state === 'closed' ? new Date(1_704_067_200_000 + (issue.seq + 1) * 1000).toISOString() : null,
  };
  if (issue.isPR) {
    const headTip = branchTip(repo, issue.headRef);
    const baseTip = branchTip(repo, issue.baseRef);
    base.pull_request = { url: `http://forge.local/api/v3/repos/${login}/${repo.name}/pulls/${issue.number}` };
    base.head = { label: `${login}:${issue.headRef}`, ref: issue.headRef, sha: headTip };
    base.base = { label: `${login}:${issue.baseRef}`, ref: issue.baseRef, sha: baseTip };
    base.merged = issue.merged;
    base.merged_at = issue.mergedAt;
    base.merge_commit_sha = issue.mergeCommitSha;
    base.draft = false;
  }
  return base;
}

function issueJsonCached(repo: Repo, issue: IssueRec): string {
  if (issue._json === null) issue._json = JSON.stringify(issueJson(repo, issue));
  return issue._json;
}

interface RestContext {
  repo: Repo;
  owner: string;
  name: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function restError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Handle one /api/v3 request. `segments` is the path after /api/v3, `query` the parsed query. */
function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
  stranger: boolean,
): void {
  const method = (req.method ?? 'GET').toUpperCase();
  const host = req.headers.host ?? '127.0.0.1';

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: `http://${host}/api/v3/user`, repository_url: `http://${host}/api/v3/repos/{owner}/{repo}` },
        { 'X-OAuth-Scopes': 'repo, user, admin:org' },
      );
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    sendJson(res, 200, { installed_version: `${SERVER_NAME}-${SERVER_VERSION}`, verifiable_password_authentication: false });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (stranger || boundLogin === null) {
      restError(res, 401, 'Bad credentials');
      return;
    }
    sendJson(res, 200, { login: boundLogin, id: 1, type: 'User' });
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      if (stranger) {
        restError(res, 401, 'Bad credentials');
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        restError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (repos.has(name)) {
        restError(res, 422, 'Validation Failed: name already exists on this account');
        return;
      }
      const repo = newRepo(name, typeof body.description === 'string' ? body.description : '', body.private !== false);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      const all = stranger ? [] : [...repos.values()];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`;
        headers.Link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      sendJson(res, 200, slice.map((repo) => repoJson(repo)), headers);
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    restError(res, 404, 'Not Found');
    return;
  }

  const owner = segments[1];
  const name = segments[2];
  if (stranger) {
    restError(res, 404, 'Not Found');
    return;
  }
  const repo = lookupRepo(owner, name);
  if (!repo) {
    restError(res, 404, 'Not Found');
    return;
  }
  const ctx: RestContext = { repo, owner, name };
  const rest = segments.slice(3);
  handleRepoRoute(req, res, ctx, rest, query, body);
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  seg: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  const { repo } = ctx;
  const method = (req.method ?? 'GET').toUpperCase();

  // /repos/{o}/{r}
  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJsonCached(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name && !repos.has(body.name)) {
        repos.delete(repo.name);
        repo.name = body.name;
        repos.set(repo.name, repo);
      }
      repo._json = null;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /branches[/{name}]
  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const out = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(res, 200, out);
      return;
    }
    if (seg.length === 2 && method === 'GET') {
      const sha = branchTip(repo, seg[1]);
      if (!sha) {
        restError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: seg[1], commit: { sha }, protected: false });
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /commits[?sha=]
  if (seg[0] === 'commits' && seg.length === 1 && method === 'GET') {
    const startRef = query.get('sha');
    let tip: string | null;
    if (startRef === null || startRef === '') tip = repo.refs.get(repo.headRef) ?? null;
    else if (/^[0-9a-f]{40}$/.test(startRef)) tip = startRef;
    else tip = repo.refs.get(`refs/heads/${startRef}`) ?? repo.refs.get(startRef) ?? null;
    if (!tip || !repo.objects.has(tip)) {
      sendJson(res, 200, []);
      return;
    }
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < 500) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      const authorMatch = /^(.*?) <(.*?)> (\d+)/.exec(commit.author);
      out.push({
        sha: oid,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: {
            name: authorMatch ? authorMatch[1] : 'Forge',
            email: authorMatch ? authorMatch[2] : 'forge@localhost',
            date: new Date((authorMatch ? parseInt(authorMatch[3], 10) : clockSec) * 1000).toISOString(),
          },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      queue.push(...commit.parents);
    }
    sendJson(res, 200, out);
    return;
  }

  // /git/refs[/...]
  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2) {
      if (method === 'GET') {
        const out = [...repo.refs.entries()].map(([ref, sha]) => ({
          ref,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
        }));
        sendJson(res, 200, out);
        return;
      }
      if (method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          restError(res, 422, 'Validation Failed: invalid ref or sha');
          return;
        }
        repo.refs.set(ref, sha);
        repo._json = null;
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
    }
    if (seg.length >= 3) {
      const ref = seg.slice(2).join('/');
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (!sha) {
          restError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) {
          restError(res, 404, 'Not Found');
          return;
        }
        repo.refs.delete(ref);
        res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
        res.end();
        return;
      }
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /contents/{path...}
  if (seg[0] === 'contents') {
    const path = seg.slice(1).join('/');
    if (method === 'GET') {
      const branch = query.get('ref') ?? defaultBranchOf(repo);
      const tip = branchTip(repo, branch);
      const flat = flatOfCommit(repo, tip);
      const file = flat.get(path);
      if (file) {
        const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: data.length,
          encoding: 'base64',
          content: data.toString('base64'),
        });
        return;
      }
      const prefix = path === '' ? '' : `${path}/`;
      const entries: Record<string, unknown>[] = [];
      const seenDirs = new Set<string>();
      for (const [entryPath, value] of flat) {
        if (!entryPath.startsWith(prefix)) continue;
        const remainder = entryPath.slice(prefix.length);
        const slash = remainder.indexOf('/');
        if (slash < 0) {
          entries.push({ type: 'file', name: remainder, path: entryPath, sha: value.oid });
        } else {
          const dir = remainder.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '' });
          }
        }
      }
      if (entries.length > 0 || path === '') {
        sendJson(res, 200, entries);
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const branch = typeof body.branch === 'string' ? body.branch : defaultBranchOf(repo);
      const content = typeof body.content === 'string' ? b64decode(body.content) : Buffer.alloc(0);
      const tip = branchTip(repo, branch) ?? branchTip(repo, defaultBranchOf(repo));
      const existing = flatOfCommit(repo, tip).get(path);
      if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
        restError(res, 409, 'Conflict: the sha does not match the current file');
        return;
      }
      const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
      const result = putFileContents(repo, branch, path, content, message);
      if (!result) {
        restError(res, 422, 'Validation Failed');
        return;
      }
      sendJson(res, existing ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' ? body.branch : defaultBranchOf(repo);
      const tip = branchTip(repo, branch);
      const existing = flatOfCommit(repo, tip).get(path);
      if (!existing) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (typeof body.sha === 'string' && body.sha !== existing.oid) {
        restError(res, 409, 'Conflict: the sha does not match the current file');
        return;
      }
      const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
      const result = putFileContents(repo, branch, path, null, message);
      sendJson(res, 200, { content: null, commit: { sha: result?.commitSha } });
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /labels
  if (seg[0] === 'labels') {
    if (seg.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    if (seg.length === 1 && method === 'POST') {
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        restError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (repo.labels.has(labelName)) {
        restError(res, 422, 'Validation Failed: name already exists');
        return;
      }
      const label = { name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(labelName, label);
      sendJson(res, 201, { name: label.name, color: label.color });
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /issues[/{n}[/comments]]
  if (seg[0] === 'issues') {
    if (seg.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          restError(res, 422, 'Validation Failed: title is required');
          return;
        }
        const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            restError(res, 422, `Validation Failed: label "${label}" does not exist`);
            return;
          }
        }
        const issue = createIssueRec(repo, title, typeof body.body === 'string' ? body.body : '', labels);
        sendJson(res, 201, issueJsonCached(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'asc');
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
        const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
        const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
        sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)));
        return;
      }
    }
    if (seg.length >= 2) {
      const number = parseInt(seg[1], 10);
      const issue = repo.issues.get(number);
      if (!issue) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (seg.length === 2) {
        if (method === 'GET') {
          // The read-benchmark hot path: serve the cached serialization.
          sendJson(res, 200, issueJsonCached(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            issue.labels = body.labels.filter((x): x is string => typeof x === 'string');
          }
          issue._json = null;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
      }
      if (seg.length === 3 && seg[2] === 'comments') {
        if (method === 'GET') {
          sendJson(
            res,
            200,
            issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: ownerLogin(), id: 1, type: 'User' } })),
          );
          return;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          const comment = { id: nextCommentId++, body: text };
          issue.comments.push(comment);
          issue._json = null;
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: ownerLogin(), id: 1, type: 'User' } });
          return;
        }
      }
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /pulls[/{n}[/files|/merge]]
  if (seg[0] === 'pulls') {
    if (seg.length === 1) {
      if (method === 'POST') {
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : defaultBranchOf(repo);
        const title = typeof body.title === 'string' ? body.title : '';
        if (!branchTip(repo, head)) {
          restError(res, 422, `Validation Failed: head branch "${head}" does not exist`);
          return;
        }
        if (!branchTip(repo, base)) {
          restError(res, 422, `Validation Failed: base branch "${base}" does not exist`);
          return;
        }
        const existing = [...repo.issues.values()].find(
          (issue) => issue.isPR && issue.state === 'open' && issue.headRef === head && issue.baseRef === base,
        );
        if (existing) {
          restError(res, 422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
          return;
        }
        const pull = createPullRec(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        sendJson(res, 201, issueJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.issues.values()].filter((issue) => issue.isPR);
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, list.map((issue) => issueJson(repo, issue)));
        return;
      }
    }
    if (seg.length >= 2) {
      const number = parseInt(seg[1], 10);
      const pull = repo.issues.get(number);
      if (!pull || !pull.isPR) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (seg.length === 2 && method === 'GET') {
        sendJson(res, 200, issueJson(repo, pull));
        return;
      }
      if (seg.length === 3 && seg[2] === 'files' && method === 'GET') {
        const changes = diffFiles(repo, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef));
        sendJson(
          res,
          200,
          changes.map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.additions + change.deletions,
          })),
        );
        return;
      }
      if (seg.length === 3 && seg[2] === 'merge' && (method === 'PUT' || method === 'POST')) {
        if (pull.state !== 'open') {
          restError(res, 405, 'Pull Request is not open');
          return;
        }
        const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        const mergeMethod = methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge';
        const sha = mergePull(repo, pull, mergeMethod);
        if (sha === null) {
          restError(res, 405, 'Pull Request is not mergeable');
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
    restError(res, 404, 'Not Found');
    return;
  }

  restError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4 subset
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selections: GqlSelection[];
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSelection[] };

interface GqlOperation {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selections: GqlSelection[] }>;
}

function gqlTokenize(source: string): { kind: string; value: string }[] {
  const tokens: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j++;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

function gqlParse(source: string): GqlDocument {
  const tokens = gqlTokenize(source);
  let pos = 0;
  const peek = (): { kind: string; value: string } | undefined => tokens[pos];
  const next = (): { kind: string; value: string } => {
    const token = tokens[pos++];
    if (!token) throw new Error('unexpected end of document');
    return token;
  };
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  };
  const skipBalanced = (open: string, close: string): void => {
    expectPunct(open);
    let depth = 1;
    while (depth > 0 && pos < tokens.length) {
      const token = next();
      if (token.value === open) depth++;
      else if (token.value === close) depth--;
    }
  };
  const parseValue = (): GqlValue => {
    const token = next();
    if (token.value === '$') return { kind: 'var', name: next().value };
    if (token.value === '[') {
      const values: GqlValue[] = [];
      while (peek() && peek()?.value !== ']') values.push(parseValue());
      expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (peek() && peek()?.value !== '}') {
        const name = next().value;
        expectPunct(':');
        fields.push({ name, value: parseValue() });
      }
      expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return /[.eE]/.test(token.value) ? { kind: 'float', value: parseFloat(token.value) } : { kind: 'int', value: parseInt(token.value, 10) };
    }
    if (token.value === 'true') return { kind: 'bool', value: true };
    if (token.value === 'false') return { kind: 'bool', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  };
  const parseSelectionSet = (): GqlSelection[] => {
    expectPunct('{');
    const selections: GqlSelection[] = [];
    while (peek() && peek()?.value !== '}') selections.push(parseSelection());
    expectPunct('}');
    return selections;
  };
  const parseSelection = (): GqlSelection => {
    const token = peek();
    if (token && token.value === '...') {
      next();
      const after = peek();
      if (after && after.kind === 'name' && after.value === 'on') {
        next();
        const typeCondition = next().value;
        if (peek()?.value === '@') {
          next();
          next();
          if (peek()?.value === '(') skipBalanced('(', ')');
        }
        return { kind: 'inline', typeCondition, selections: parseSelectionSet() };
      }
      return { kind: 'spread', name: next().value };
    }
    let name = next().value;
    let alias: string | null = null;
    if (peek()?.value === ':') {
      next();
      alias = name;
      name = next().value;
    }
    const args: { name: string; value: GqlValue }[] = [];
    if (peek()?.value === '(') {
      next();
      while (peek() && peek()?.value !== ')') {
        const argName = next().value;
        expectPunct(':');
        args.push({ name: argName, value: parseValue() });
      }
      expectPunct(')');
    }
    // Directives are parsed and ignored.
    while (peek()?.value === '@') {
      next();
      next();
      if (peek()?.value === '(') skipBalanced('(', ')');
    }
    const selections = peek()?.value === '{' ? parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, selections } };
  };
  const document: GqlDocument = { operations: [], fragments: new Map() };
  while (pos < tokens.length) {
    const token = peek();
    if (!token) break;
    if (token.value === '{') {
      document.operations.push({ operation: 'query', name: null, selections: parseSelectionSet() });
      continue;
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      const operation = next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (peek()?.kind === 'name') name = next().value;
      if (peek()?.value === '(') skipBalanced('(', ')');
      while (peek()?.value === '@') {
        next();
        next();
        if (peek()?.value === '(') skipBalanced('(', ')');
      }
      document.operations.push({ operation, name, selections: parseSelectionSet() });
      continue;
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      next();
      const fragName = next().value;
      next(); // 'on'
      const typeCondition = next().value;
      document.fragments.set(fragName, { typeCondition, selections: parseSelectionSet() });
      continue;
    }
    next();
  }
  return document;
}

function gqlValue(value: GqlValue, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => gqlValue(entry, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlValue(field.value, vars);
      return out;
    }
  }
}

function gqlArgs(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlValue(arg.value, vars);
  return out;
}

// --- schema -----------------------------------------------------------------

type GqlResolver = (parent: never, args: Record<string, unknown>) => unknown;

interface GqlFieldDef {
  type: string; // named type of the value (or of list items)
  list?: boolean;
  resolve: GqlResolver;
}

interface GqlTypeDef {
  kind: 'object' | 'enum';
  fields?: Record<string, GqlFieldDef>;
  enumValues?: string[];
}

function findRepoByGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const repoId = parseInt(parsed.parts[0], 10);
  for (const repo of repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByGlobalId(id: unknown): { repo: Repo; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || (parsed.kind !== 'Issue' && parsed.kind !== 'PullRequest')) return null;
  const repoId = parseInt(parsed.parts[0], 10);
  const number = parseInt(parsed.parts[1], 10);
  for (const repo of repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    if (issue) return { repo, issue };
  }
  return null;
}

function repoOfIssue(issue: IssueRec): Repo | null {
  for (const repo of repos.values()) if (repo.issues.get(issue.number) === issue) return repo;
  return null;
}

const GQL_TYPES: Record<string, GqlTypeDef> = {
  Query: {
    kind: 'object',
    fields: {
      viewer: {
        type: 'User',
        resolve: () => ({ __gqlType: 'User', login: ownerLogin() }),
      },
      repository: {
        type: 'Repository',
        resolve: (_parent, args) => {
          if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
          return lookupRepo(args.owner, args.name);
        },
      },
      node: {
        type: 'Node',
        resolve: (_parent, args) => {
          const repo = findRepoByGlobalId(args.id);
          if (repo) return repo;
          const found = findIssueByGlobalId(args.id as string);
          if (found) return found.issue;
          return null;
        },
      },
      rateLimit: {
        type: 'RateLimit',
        resolve: () => ({ __gqlType: 'RateLimit' }),
      },
    },
  },
  Mutation: {
    kind: 'object',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = findRepoByGlobalId(input.repositoryId);
          if (!repo) throw new Error('repository not found');
          const issue = createIssueRec(
            repo,
            typeof input.title === 'string' ? input.title : '',
            typeof input.body === 'string' ? input.body : '',
            [],
          );
          return { __gqlType: 'CreateIssuePayload', issue };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(input.issueId as string);
          if (!found) throw new Error('issue not found');
          found.issue.state = 'closed';
          found.issue._json = null;
          return { __gqlType: 'CloseIssuePayload', issue: found.issue };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(input.issueId as string);
          if (!found) throw new Error('issue not found');
          found.issue.state = 'open';
          found.issue._json = null;
          return { __gqlType: 'ReopenIssuePayload', issue: found.issue };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = findRepoByGlobalId(input.repositoryId);
          if (!repo) throw new Error('repository not found');
          const head = typeof input.headRefName === 'string' ? input.headRefName : '';
          const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
          if (!branchTip(repo, head)) throw new Error(`head branch "${head}" does not exist`);
          if (!branchTip(repo, base)) throw new Error(`base branch "${base}" does not exist`);
          const pull = createPullRec(
            repo,
            typeof input.title === 'string' ? input.title : '',
            typeof input.body === 'string' ? input.body : '',
            head,
            base,
          );
          return { __gqlType: 'CreatePullRequestPayload', pullRequest: pull };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(input.pullRequestId as string);
          if (!found || !found.issue.isPR) throw new Error('pull request not found');
          const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
          const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
          const sha = mergePull(found.repo, found.issue, method);
          if (sha === null) throw new Error('pull request is not mergeable');
          return { __gqlType: 'MergePullRequestPayload', pullRequest: found.issue };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = findIssueByGlobalId(input.subjectId as string);
          if (!found) throw new Error('subject not found');
          const comment: CommentRec = { id: nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
          found.issue.comments.push(comment);
          found.issue._json = null;
          const node = {
            __gqlType: 'IssueComment',
            id: globalId('IssueComment', found.repo.id, found.issue.number, comment.id),
            body: comment.body,
          };
          return { __gqlType: 'AddCommentPayload', commentEdge: { __gqlType: 'IssueCommentEdge', node, cursor: b64encode(`cursor:${comment.id}`) } };
        },
      },
    },
  },
  User: {
    kind: 'object',
    fields: {
      login: { type: 'String', resolve: (user) => (user as { login: string }).login },
      id: { type: 'ID', resolve: () => globalId('User', 1) },
      name: { type: 'String', resolve: (user) => (user as { login: string }).login },
      url: { type: 'String', resolve: (user) => `http://forge.local/${(user as { login: string }).login}` },
    },
  },
  Repository: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (repo) => globalId('Repository', (repo as Repo).id) },
      databaseId: { type: 'Int', resolve: (repo) => (repo as Repo).id },
      name: { type: 'String', resolve: (repo) => (repo as Repo).name },
      nameWithOwner: { type: 'String', resolve: (repo) => `${ownerLogin()}/${(repo as Repo).name}` },
      description: { type: 'String', resolve: (repo) => (repo as Repo).description },
      isPrivate: { type: 'Boolean', resolve: (repo) => (repo as Repo).priv },
      owner: { type: 'User', resolve: () => ({ __gqlType: 'User', login: ownerLogin() }) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (repo) => ({ __gqlType: 'Ref', name: defaultBranchOf(repo as Repo) }),
      },
      viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasWikiEnabled: { type: 'Boolean', resolve: () => false },
      hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
      isFork: { type: 'Boolean', resolve: () => false },
      isArchived: { type: 'Boolean', resolve: () => false },
      url: { type: 'String', resolve: (repo) => `http://forge.local/${ownerLogin()}/${(repo as Repo).name}` },
      createdAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
      updatedAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
      issue: {
        type: 'Issue',
        resolve: (repo, args) => {
          const found = (repo as Repo).issues.get(typeof args.number === 'number' ? args.number : -1);
          return found && !found.isPR ? found : null;
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (repo, args) => ({ __gqlType: 'IssueConnection', repo: repo as Repo, args }),
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (repo, args) => {
          const found = (repo as Repo).issues.get(typeof args.number === 'number' ? args.number : -1);
          return found && found.isPR ? found : null;
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (repo, args) => ({ __gqlType: 'PullRequestConnection', repo: repo as Repo, args }),
      },
    },
  },
  Ref: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (ref) => (ref as { name: string }).name },
      prefix: { type: 'String', resolve: () => 'refs/heads/' },
    },
  },
  Issue: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (issue) => {
          const repo = repoOfIssue(issue as IssueRec);
          return globalId('Issue', repo ? repo.id : 0, (issue as IssueRec).number);
        },
      },
      number: { type: 'Int', resolve: (issue) => (issue as IssueRec).number },
      title: { type: 'String', resolve: (issue) => (issue as IssueRec).title },
      body: { type: 'String', resolve: (issue) => (issue as IssueRec).body },
      bodyText: { type: 'String', resolve: (issue) => (issue as IssueRec).body },
      state: { type: 'String', resolve: (issue) => ((issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED') },
      author: { type: 'User', resolve: () => ({ __gqlType: 'User', login: ownerLogin() }) },
      labels: {
        type: 'LabelConnection',
        resolve: (issue) => ({ __gqlType: 'LabelConnection', names: (issue as IssueRec).labels }),
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (issue) => ({ __gqlType: 'IssueCommentConnection', issue: issue as IssueRec }),
      },
      createdAt: { type: 'String', resolve: (issue) => new Date(1_704_067_200_000 + (issue as IssueRec).seq * 1000).toISOString() },
      updatedAt: { type: 'String', resolve: (issue) => new Date(1_704_067_200_000 + (issue as IssueRec).seq * 1000).toISOString() },
      closedAt: {
        type: 'String',
        resolve: (issue) => ((issue as IssueRec).state === 'closed' ? new Date(1_704_067_200_000 + (issue as IssueRec).seq * 1000).toISOString() : null),
      },
      url: {
        type: 'String',
        resolve: (issue) => {
          const repo = repoOfIssue(issue as IssueRec);
          return `http://forge.local/${ownerLogin()}/${repo ? repo.name : ''}/issues/${(issue as IssueRec).number}`;
        },
      },
      repository: {
        type: 'Repository',
        resolve: (issue) => repoOfIssue(issue as IssueRec),
      },
    },
  },
  PullRequest: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (pull) => {
          const repo = repoOfIssue(pull as IssueRec);
          return globalId('PullRequest', repo ? repo.id : 0, (pull as IssueRec).number);
        },
      },
      number: { type: 'Int', resolve: (pull) => (pull as IssueRec).number },
      title: { type: 'String', resolve: (pull) => (pull as IssueRec).title },
      body: { type: 'String', resolve: (pull) => (pull as IssueRec).body },
      state: {
        type: 'String',
        resolve: (pull) => {
          const rec = pull as IssueRec;
          return rec.merged ? 'MERGED' : rec.state === 'open' ? 'OPEN' : 'CLOSED';
        },
      },
      merged: { type: 'Boolean', resolve: (pull) => (pull as IssueRec).merged },
      mergedAt: { type: 'String', resolve: (pull) => (pull as IssueRec).mergedAt },
      headRefName: { type: 'String', resolve: (pull) => (pull as IssueRec).headRef },
      baseRefName: { type: 'String', resolve: (pull) => (pull as IssueRec).baseRef },
      mergeable: {
        type: 'String',
        resolve: (pull) => {
          const repo = repoOfIssue(pull as IssueRec);
          if (!repo) return 'UNKNOWN';
          const rec = pull as IssueRec;
          return rec.state !== 'open' ? 'UNKNOWN' : pullMergeable(repo, rec);
        },
      },
      mergeCommit: {
        type: 'Commit',
        resolve: (pull) => {
          const rec = pull as IssueRec;
          return rec.mergeCommitSha ? { __gqlType: 'Commit', oid: rec.mergeCommitSha } : null;
        },
      },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (pull, args) => ({ __gqlType: 'PullRequestChangedFileConnection', pull: pull as IssueRec, args }),
      },
      author: { type: 'User', resolve: () => ({ __gqlType: 'User', login: ownerLogin() }) },
      createdAt: { type: 'String', resolve: (pull) => new Date(1_704_067_200_000 + (pull as IssueRec).seq * 1000).toISOString() },
      updatedAt: { type: 'String', resolve: (pull) => new Date(1_704_067_200_000 + (pull as IssueRec).seq * 1000).toISOString() },
    },
  },
  Commit: {
    kind: 'object',
    fields: {
      oid: { type: 'String', resolve: (commit) => (commit as { oid: string }).oid },
      abbreviatedOid: { type: 'String', resolve: (commit) => (commit as { oid: string }).oid.slice(0, 7) },
    },
  },
  IssueConnection: {
    kind: 'object',
    fields: {
      nodes: { type: 'Issue', list: true, resolve: (conn) => issueConnectionPage(conn as never).nodes },
      edges: {
        type: 'IssueEdge',
        list: true,
        resolve: (conn) => issueConnectionPage(conn as never).nodes.map((node, index) => ({ __gqlType: 'IssueEdge', node, cursor: b64encode(`cursor:${index}`) })),
      },
      pageInfo: { type: 'PageInfo', resolve: (conn) => issueConnectionPage(conn as never).pageInfo },
      totalCount: { type: 'Int', resolve: (conn) => issueConnectionPage(conn as never).totalCount },
    },
  },
  IssueEdge: {
    kind: 'object',
    fields: {
      node: { type: 'Issue', resolve: (edge) => (edge as { node: IssueRec }).node },
      cursor: { type: 'String', resolve: (edge) => (edge as { cursor: string }).cursor },
    },
  },
  PullRequestConnection: {
    kind: 'object',
    fields: {
      nodes: { type: 'PullRequest', list: true, resolve: (conn) => pullConnectionPage(conn as never).nodes },
      pageInfo: { type: 'PageInfo', resolve: (conn) => pullConnectionPage(conn as never).pageInfo },
      totalCount: { type: 'Int', resolve: (conn) => pullConnectionPage(conn as never).totalCount },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'object',
    fields: {
      nodes: {
        type: 'PullRequestChangedFile',
        list: true,
        resolve: (conn) => {
          const { pull, args } = conn as { pull: IssueRec; args: Record<string, unknown> };
          const repo = repoOfIssue(pull);
          if (!repo) return [];
          const first = typeof args.first === 'number' ? args.first : 100;
          return diffFiles(repo, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef))
            .slice(0, first)
            .map((change) => ({
              __gqlType: 'PullRequestChangedFile',
              path: change.filename,
              additions: change.additions,
              deletions: change.deletions,
              changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }));
        },
      },
      totalCount: {
        type: 'Int',
        resolve: (conn) => {
          const { pull } = conn as { pull: IssueRec };
          const repo = repoOfIssue(pull);
          if (!repo) return 0;
          return diffFiles(repo, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef)).length;
        },
      },
    },
  },
  PullRequestChangedFile: {
    kind: 'object',
    fields: {
      path: { type: 'String', resolve: (file) => (file as { path: string }).path },
      additions: { type: 'Int', resolve: (file) => (file as { additions: number }).additions },
      deletions: { type: 'Int', resolve: (file) => (file as { deletions: number }).deletions },
      changeType: { type: 'String', resolve: (file) => (file as { changeType: string }).changeType },
    },
  },
  LabelConnection: {
    kind: 'object',
    fields: {
      nodes: {
        type: 'Label',
        list: true,
        resolve: (conn) => (conn as { names: string[] }).names.map((name) => ({ __gqlType: 'Label', name })),
      },
      totalCount: { type: 'Int', resolve: (conn) => (conn as { names: string[] }).names.length },
    },
  },
  Label: {
    kind: 'object',
    fields: {
      name: { type: 'String', resolve: (label) => (label as { name: string }).name },
      id: { type: 'ID', resolve: (label) => globalId('Label', (label as { name: string }).name) },
    },
  },
  IssueCommentConnection: {
    kind: 'object',
    fields: {
      nodes: {
        type: 'IssueComment',
        list: true,
        resolve: (conn) => {
          const issue = (conn as { issue: IssueRec }).issue;
          const repo = repoOfIssue(issue);
          return issue.comments.map((comment) => ({
            __gqlType: 'IssueComment',
            id: globalId('IssueComment', repo ? repo.id : 0, issue.number, comment.id),
            body: comment.body,
          }));
        },
      },
      totalCount: { type: 'Int', resolve: (conn) => (conn as { issue: IssueRec }).issue.comments.length },
    },
  },
  IssueComment: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (comment) => (comment as { id: string }).id },
      body: { type: 'String', resolve: (comment) => (comment as { body: string }).body },
      author: { type: 'User', resolve: () => ({ __gqlType: 'User', login: ownerLogin() }) },
    },
  },
  IssueCommentEdge: {
    kind: 'object',
    fields: {
      node: { type: 'IssueComment', resolve: (edge) => (edge as { node: unknown }).node },
      cursor: { type: 'String', resolve: (edge) => (edge as { cursor: string }).cursor },
    },
  },
  PageInfo: {
    kind: 'object',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (info) => (info as { hasNextPage: boolean }).hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (info) => (info as { hasPreviousPage?: boolean }).hasPreviousPage ?? false },
      endCursor: { type: 'String', resolve: (info) => (info as { endCursor: string | null }).endCursor },
      startCursor: { type: 'String', resolve: (info) => (info as { startCursor?: string | null }).startCursor ?? null },
    },
  },
  RateLimit: {
    kind: 'object',
    fields: {
      limit: { type: 'Int', resolve: () => 5000 },
      cost: { type: 'Int', resolve: () => 1 },
      remaining: { type: 'Int', resolve: () => 5000 },
      resetAt: { type: 'String', resolve: () => '2024-01-01T01:00:00Z' },
    },
  },
  CreateIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (payload) => (payload as { issue: IssueRec }).issue },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  CloseIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (payload) => (payload as { issue: IssueRec }).issue },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  ReopenIssuePayload: {
    kind: 'object',
    fields: {
      issue: { type: 'Issue', resolve: (payload) => (payload as { issue: IssueRec }).issue },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  CreatePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (payload) => (payload as { pullRequest: IssueRec }).pullRequest },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  MergePullRequestPayload: {
    kind: 'object',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (payload) => (payload as { pullRequest: IssueRec }).pullRequest },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  AddCommentPayload: {
    kind: 'object',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (payload) => (payload as { commentEdge: unknown }).commentEdge },
      clientMutationId: { type: 'String', resolve: () => null },
    },
  },
  Node: {
    kind: 'object',
    fields: {
      id: {
        type: 'ID',
        resolve: (node) => {
          const rec = node as { __gqlType: string };
          if (rec.__gqlType === 'Repository') return globalId('Repository', (node as Repo).id);
          const issue = node as IssueRec;
          const repo = repoOfIssue(issue);
          return globalId(issue.isPR ? 'PullRequest' : 'Issue', repo ? repo.id : 0, issue.number);
        },
      },
    },
  },
  SearchType: { kind: 'enum', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'enum', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'enum', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'enum', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'enum', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'enum', enumValues: ['ASC', 'DESC'] },
};

interface ConnectionPage {
  nodes: IssueRec[];
  pageInfo: { __gqlType: string; hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null };
  totalCount: number;
}

function pageInfoFor(total: number, start: number, count: number): ConnectionPage['pageInfo'] {
  return {
    __gqlType: 'PageInfo',
    hasNextPage: start + count < total,
    hasPreviousPage: start > 0,
    endCursor: count > 0 ? b64encode(`cursor:${start + count - 1}`) : null,
    startCursor: count > 0 ? b64encode(`cursor:${start}`) : null,
  };
}

function cursorIndex(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const text = b64decode(after).toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

function issueConnectionPage(conn: { repo: Repo; args: Record<string, unknown> }): ConnectionPage {
  const { repo, args } = conn;
  let list = [...repo.issues.values()].filter((issue) => !issue.isPR);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  const total = list.length;
  const start = cursorIndex(args.after) + 1;
  const first = typeof args.first === 'number' ? args.first : total;
  const nodes = list.slice(start, start + first);
  return { nodes, pageInfo: pageInfoFor(total, start, nodes.length), totalCount: total };
}

function pullConnectionPage(conn: { repo: Repo; args: Record<string, unknown> }): ConnectionPage {
  const { repo, args } = conn;
  let list = [...repo.issues.values()].filter((issue) => issue.isPR);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.merged ? 'MERGED' : issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list.sort((a, b) => b.number - a.number);
  const total = list.length;
  const start = cursorIndex(args.after) + 1;
  const first = typeof args.first === 'number' ? args.first : total;
  const nodes = list.slice(start, start + first);
  return { nodes, pageInfo: pageInfoFor(total, start, nodes.length), totalCount: total };
}

// --- GraphQL execution --------------------------------------------------------

interface GqlContext {
  document: GqlDocument;
  vars: Record<string, unknown>;
  errors: { message: string }[];
}

function runtimeTypeOf(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && '__gqlType' in value) {
    return (value as { __gqlType: string }).__gqlType;
  }
  return null;
}

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

/** Expand a selection set into response-key -> merged field, honoring fragments. */
function collectFields(
  ctx: GqlContext,
  runtimeType: string | null,
  selections: GqlSelection[],
  out: Map<string, GqlField>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.field.alias ?? selection.field.name;
      const existing = out.get(key);
      if (existing) existing.selections.push(...selection.field.selections);
      else out.set(key, { ...selection.field, selections: [...selection.field.selections] });
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || runtimeType === null || selection.typeCondition === runtimeType || selection.typeCondition === 'Node') {
        collectFields(ctx, runtimeType, selection.selections, out);
      }
    } else {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment && (runtimeType === null || fragment.typeCondition === runtimeType || fragment.typeCondition === 'Node')) {
        collectFields(ctx, runtimeType, fragment.selections, out);
      }
    }
  }
}

function introspectType(name: string): Record<string, unknown> | null {
  const def = GQL_TYPES[name];
  if (!def) return null;
  return { __gqlType: '__Type', name, kind: def.kind === 'enum' ? 'ENUM' : 'OBJECT', def };
}

function executeSelectionSet(ctx: GqlContext, typeName: string, parent: unknown, selections: GqlSelection[]): Record<string, unknown> {
  const runtimeType = runtimeTypeOf(parent) ?? typeName;
  const fields = new Map<string, GqlField>();
  collectFields(ctx, runtimeType, selections, fields);
  const out: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    out[key] = executeField(ctx, typeName, runtimeType, parent, field);
  }
  return out;
}

function executeField(
  ctx: GqlContext,
  typeName: string,
  runtimeType: string,
  parent: unknown,
  field: GqlField,
): unknown {
  if (field.name === '__typename') return runtimeType;
  if (field.name === '__type' && typeName === 'Query') {
    const args = gqlArgs(field, ctx.vars);
    const found = typeof args.name === 'string' ? introspectType(args.name) : null;
    if (found === null) return null;
    return executeSelectionSet(ctx, '__Type', found, field.selections);
  }
  if (field.name === '__schema' && typeName === 'Query') {
    const schema = {
      __gqlType: '__Schema',
      types: Object.keys(GQL_TYPES).map((name) => introspectType(name)),
      queryType: introspectType('Query'),
      mutationType: introspectType('Mutation'),
    };
    return executeSelectionSet(ctx, '__Schema', schema, field.selections);
  }
  const typeDef = GQL_TYPES[typeName] ?? GQL_TYPES[runtimeType];
  const fieldDef = typeDef?.fields?.[field.name] ?? GQL_TYPES.Node.fields?.[field.name];
  if (!fieldDef) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${runtimeType}".` });
    return null;
  }
  let value: unknown;
  try {
    value = fieldDef.resolve(parent as never, gqlArgs(field, ctx.vars));
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  return completeValue(ctx, fieldDef, value, field);
}

function completeValue(ctx: GqlContext, fieldDef: GqlFieldDef, value: unknown, field: GqlField): unknown {
  if (value === null || value === undefined) return null;
  if (fieldDef.list) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeSingle(ctx, fieldDef.type, item, field));
  }
  return completeSingle(ctx, fieldDef.type, value, field);
}

function completeSingle(ctx: GqlContext, type: string, value: unknown, field: GqlField): unknown {
  if (value === null || value === undefined) return null;
  if (SCALAR_TYPES.has(type)) return type === 'ID' || type === 'String' ? String(value) : value;
  const def = GQL_TYPES[type];
  if (def && def.kind === 'enum') return String(value);
  const runtimeType = runtimeTypeOf(value) ?? type;
  return executeSelectionSet(ctx, runtimeType, value, field.selections);
}

// --- GraphQL validation (unknown fields are a 200 with an errors array) -------

function validateSelections(
  ctx: GqlContext,
  typeName: string,
  selections: GqlSelection[],
  errors: { message: string }[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const name = selection.field.name;
      if (name === '__typename' || name === '__type' || name === '__schema') continue;
      const def = GQL_TYPES[typeName];
      const fieldDef = def?.fields?.[name] ?? (typeName === 'Node' ? undefined : GQL_TYPES.Node.fields?.[name]);
      if (!fieldDef) {
        errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
        continue;
      }
      if (selection.field.selections.length > 0 && !SCALAR_TYPES.has(fieldDef.type)) {
        validateSelections(ctx, fieldDef.type, selection.field.selections, errors);
      }
    } else if (selection.kind === 'inline') {
      validateSelections(ctx, selection.typeCondition ?? typeName, selection.selections, errors);
    } else {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment) validateSelections(ctx, fragment.typeCondition, fragment.selections, errors);
      else errors.push({ message: `Unknown fragment "${selection.name}".` });
    }
  }
}

// --- introspection object types ----------------------------------------------

GQL_TYPES['__Type'] = {
  kind: 'object',
  fields: {
    name: { type: 'String', resolve: (t) => (t as { name: string }).name },
    kind: { type: 'String', resolve: (t) => (t as { kind: string }).kind },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '__Field',
      list: true,
      resolve: (t) => {
        const def = (t as { def: GqlTypeDef }).def;
        if (!def.fields) return null;
        return Object.entries(def.fields).map(([name, fieldDef]) => ({
          __gqlType: '__Field',
          name,
          typeName: fieldDef.type,
          list: fieldDef.list ?? false,
        }));
      },
    },
    enumValues: {
      type: '__EnumValue',
      list: true,
      resolve: (t) => {
        const def = (t as { def: GqlTypeDef }).def;
        if (!def.enumValues) return null;
        return def.enumValues.map((name) => ({ __gqlType: '__EnumValue', name }));
      },
    },
    possibleTypes: { type: '__Type', list: true, resolve: () => null },
    inputFields: { type: '__InputValue', list: true, resolve: () => null },
    ofType: { type: '__Type', resolve: () => null },
    specifiedByURL: { type: 'String', resolve: () => null },
    isOneOf: { type: 'Boolean', resolve: () => false },
  },
};
GQL_TYPES['__Field'] = {
  kind: 'object',
  fields: {
    name: { type: 'String', resolve: (f) => (f as { name: string }).name },
    description: { type: 'String', resolve: () => null },
    isDeprecated: { type: 'Boolean', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
    args: { type: '__InputValue', list: true, resolve: () => [] },
    type: {
      type: '__Type',
      resolve: (f) => {
        const rec = f as { typeName: string; list: boolean };
        const inner = introspectType(rec.typeName) ?? { __gqlType: '__Type', name: rec.typeName, kind: 'SCALAR', def: { kind: 'object' } };
        if (rec.list) return { __gqlType: '__Type', name: null, kind: 'LIST', def: { kind: 'object' }, ofTypeInner: inner };
        return inner;
      },
    },
  },
};
GQL_TYPES['__EnumValue'] = {
  kind: 'object',
  fields: {
    name: { type: 'String', resolve: (v) => (v as { name: string }).name },
    description: { type: 'String', resolve: () => null },
    isDeprecated: { type: 'Boolean', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};
GQL_TYPES['__Schema'] = {
  kind: 'object',
  fields: {
    types: { type: '__Type', list: true, resolve: (s) => (s as { types: unknown[] }).types },
    queryType: { type: '__Type', resolve: (s) => (s as { queryType: unknown }).queryType },
    mutationType: { type: '__Type', resolve: (s) => (s as { mutationType: unknown }).mutationType },
    subscriptionType: { type: '__Type', resolve: () => null },
    directives: { type: '__Directive', list: true, resolve: () => [] },
    description: { type: 'String', resolve: () => null },
  },
};
GQL_TYPES['__InputValue'] = {
  kind: 'object',
  fields: {
    name: { type: 'String', resolve: () => '' },
    description: { type: 'String', resolve: () => null },
    type: { type: '__Type', resolve: () => null },
    defaultValue: { type: 'String', resolve: () => null },
    isDeprecated: { type: 'Boolean', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};
GQL_TYPES['__Directive'] = {
  kind: 'object',
  fields: {
    name: { type: 'String', resolve: () => '' },
    description: { type: 'String', resolve: () => null },
    locations: { type: 'String', list: true, resolve: () => [] },
    args: { type: '__InputValue', list: true, resolve: () => [] },
    isRepeatable: { type: 'Boolean', resolve: () => false },
  },
};
// __Type.ofType needs the wrapped type for LIST kinds.
(GQL_TYPES['__Type'].fields as Record<string, GqlFieldDef>).ofType = {
  type: '__Type',
  resolve: (t) => (t as { ofTypeInner?: unknown }).ofTypeInner ?? null,
};

/** Execute one GraphQL operation body ({query, variables, operationName}). */
function executeGraphql(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = (body.variables && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let document: GqlDocument;
  try {
    document = gqlParse(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation: GqlOperation | undefined;
  if (operationName !== null) operation = document.operations.find((op) => op.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  else operation = document.operations[0];
  if (!operation) return { errors: [{ message: 'operation not found' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: GqlContext = { document, vars, errors: [] };
  const validationErrors: { message: string }[] = [];
  validateSelections(ctx, rootType, operation.selections, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const data = executeSelectionSet(ctx, rootType, { __gqlType: rootType }, operation.selections);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

function handleGraphql(res: ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeGraphql((entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, executeGraphql((body ?? {}) as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) at /mcp
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = lookupRepo(owner, name);
  if (!repo) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

function needIssue(args: Record<string, unknown>, key: string): { repo: Repo; issue: IssueRec } {
  const repo = needRepo(args);
  const number = typeof args[key] === 'number' ? (args[key] as number) : parseInt(String(args[key] ?? ''), 10);
  const issue = repo.issues.get(number);
  if (!issue) throw new Error(`issue #${number} not found`);
  return { repo, issue };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository on the forge and return its REST representation.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
    run: (args) => {
      const name = String(args.name ?? '');
      if (repos.has(name)) throw new Error(`repository ${name} already exists`);
      const repo = newRepo(name, typeof args.description === 'string' ? args.description : '', args.private !== false);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
    run: (args) => repoJson(needRepo(args)),
  },
  {
    name: 'list_repos',
    description: 'List every repository on the forge.',
    properties: {},
    required: [],
    run: () => [...repos.values()].map((repo) => repoJson(repo)),
  },
  {
    name: 'delete_repo',
    description: 'Delete a repository and all of its contents.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      repos.delete(repo.name);
      return { deleted: true, name: repo.name };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
      labels: { type: 'array', description: 'Label names to apply' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const repo = needRepo(args);
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) if (!repo.labels.has(label)) throw new Error(`label "${label}" does not exist`);
      const issue = createIssueRec(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', labels);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (args) => {
      const { repo, issue } = needIssue(args, 'issue_number');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'open, closed or all' },
      per_page: { type: 'number', description: 'Maximum issues to return' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPR);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const perPage = typeof args.per_page === 'number' ? args.per_page : 30;
      return list.slice(0, perPage).map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'update_issue',
    description: 'Update an issue: close or reopen it, or change its title and body.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
      state: { type: 'string', description: 'open or closed' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (args) => {
      const { repo, issue } = needIssue(args, 'issue_number');
      if (args.state === 'open' || args.state === 'closed') issue.state = args.state;
      if (typeof args.title === 'string') issue.title = args.title;
      if (typeof args.body === 'string') issue.body = args.body;
      issue._json = null;
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue or pull request.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue or pull request number' },
      body: { type: 'string', description: 'Comment body' },
    },
    required: ['owner', 'repo', 'issue_number', 'body'],
    run: (args) => {
      const { issue } = needIssue(args, 'issue_number');
      const comment = { id: nextCommentId++, body: String(args.body ?? '') };
      issue.comments.push(comment);
      issue._json = null;
      return { id: comment.id, body: comment.body };
    },
  },
  {
    name: 'list_comments',
    description: 'List the comments on an issue or pull request.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue or pull request number' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (args) => {
      const { issue } = needIssue(args, 'issue_number');
      return issue.comments.map((comment) => ({ id: comment.id, body: comment.body }));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = needRepo(args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!branchTip(repo, head)) throw new Error(`head branch "${head}" does not exist`);
      if (!branchTip(repo, base)) throw new Error(`base branch "${base}" does not exist`);
      const pull = createPullRec(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      return issueJson(repo, pull);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const { repo, issue } = needIssue(args, 'pull_number');
      if (!issue.isPR) throw new Error(`#${issue.number} is not a pull request`);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'open, closed or all' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].filter((issue) => issue.isPR);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return list.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (merge, squash or rebase).',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
      merge_method: { type: 'string', description: 'merge, squash or rebase' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const { repo, issue } = needIssue(args, 'pull_number');
      if (!issue.isPR) throw new Error(`#${issue.number} is not a pull request`);
      if (issue.state !== 'open') throw new Error('pull request is not open');
      const method = args.merge_method === 'squash' ? 'squash' : args.merge_method === 'rebase' ? 'rebase' : 'merge';
      const sha = mergePull(repo, issue, method);
      if (sha === null) throw new Error('pull request is not mergeable');
      return { sha, merged: true, message: 'Pull Request successfully merged', pull_request: issueJson(repo, issue) };
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository with their tip commits.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      return [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch from another branch (or from a commit sha).',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'New branch name' },
      from_branch: { type: 'string', description: 'Branch to start from' },
      sha: { type: 'string', description: 'Commit sha to start from' },
    },
    required: ['owner', 'repo', 'branch'],
    run: (args) => {
      const repo = needRepo(args);
      const branch = String(args.branch ?? '');
      const sha =
        typeof args.sha === 'string' && repo.objects.has(args.sha)
          ? args.sha
          : branchTip(repo, typeof args.from_branch === 'string' ? args.from_branch : defaultBranchOf(repo));
      if (!sha) throw new Error('no commit to branch from');
      repo.refs.set(`refs/heads/${branch}`, sha);
      return { ref: `refs/heads/${branch}`, object: { sha } };
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository branch as UTF-8 text.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['owner', 'repo', 'path'],
    run: (args) => {
      const repo = needRepo(args);
      const branch = typeof args.branch === 'string' ? args.branch : defaultBranchOf(repo);
      const path = String(args.path ?? '');
      const file = flatOfCommit(repo, branchTip(repo, branch)).get(path);
      if (!file) throw new Error(`file ${path} not found`);
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      return { name: path.split('/').pop(), path, sha: file.oid, size: data.length, encoding: 'base64', content: data.toString('base64'), text: data.toString('utf8') };
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a file on a branch, committing the change.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'New file content (UTF-8 text)' },
      message: { type: 'string', description: 'Commit message' },
      branch: { type: 'string', description: 'Branch name' },
      sha: { type: 'string', description: 'Current blob sha when updating' },
    },
    required: ['owner', 'repo', 'path', 'content', 'message'],
    run: (args) => {
      const repo = needRepo(args);
      const branch = typeof args.branch === 'string' ? args.branch : defaultBranchOf(repo);
      const path = String(args.path ?? '');
      const tip = branchTip(repo, branch) ?? branchTip(repo, defaultBranchOf(repo));
      const existing = flatOfCommit(repo, tip).get(path);
      if (existing && typeof args.sha === 'string' && args.sha !== existing.oid) throw new Error('sha does not match the current file');
      const result = putFileContents(repo, branch, path, Buffer.from(String(args.content ?? ''), 'utf8'), String(args.message ?? `Update ${path}`));
      if (!result) throw new Error('could not write the file');
      return { content: { path, sha: result.blobSha }, commit: { sha: result.commitSha } };
    },
  },
  {
    name: 'list_commits',
    description: 'List commits reachable from a branch, newest first.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch name' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      const branch = typeof args.branch === 'string' ? args.branch : defaultBranchOf(repo);
      const tip = branchTip(repo, branch);
      if (!tip) return [];
      return commitsSince(repo, tip, null).slice(0, 100).map((oid) => {
        const commit = parseCommit((repo.objects.get(oid) as GitObject).data);
        return { sha: oid, commit: { message: commit.message, tree: { sha: commit.tree } }, parents: commit.parents.map((parent) => ({ sha: parent })) };
      });
    },
  },
  {
    name: 'get_me',
    description: 'Get the authenticated user (the forge owner).',
    properties: {},
    required: [],
    run: () => ({ login: ownerLogin(), id: 1, type: 'User' }),
  },
];

/** The tools/list payload, built once so repeated calls are byte-for-byte identical. */
const MCP_TOOLS_LIST = {
  tools: MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([name, prop]) => [
          name,
          prop.type === 'array'
            ? { type: 'array', items: { type: 'string' }, description: prop.description }
            : { type: prop.type, description: prop.description },
        ]),
      ),
      required: tool.required,
      additionalProperties: false,
    },
  })),
};

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpDiscoverResult(): Record<string, unknown> {
  const info = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'complete',
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} },
    serverInfo: info,
    instructions: 'A GitHub-compatible forge. Repositories, issues and pull requests created here are the same objects the REST and GraphQL surfaces serve.',
    _meta: { 'io.modelcontextprotocol/serverInfo': info },
  };
}

function handleMcpMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;
  const respond = (result: unknown): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result };
  const respondError = (code: number, text: string): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } };

  switch (method) {
    case 'server/discover':
      return respond(mcpDiscoverResult());
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return respond({
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond(MCP_TOOLS_LIST);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (!tool) return respondError(-32602, `unknown tool: ${name}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return respondError(-32602, `missing required argument: ${required}`);
        }
      }
      try {
        return respond(toolResult(tool.run(args)));
      } catch (err) {
        return respond(toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    case 'resources/list':
      return respond({ resources: [] });
    case 'resources/templates/list':
      return respond({ resourceTemplates: [] });
    case 'prompts/list':
      return respond({ prompts: [] });
    case 'logging/setLevel':
      return respond({});
    default:
      if (method.startsWith('notifications/')) return null;
      return respondError(-32601, `method not found: ${method}`);
  }
}

function handleMcp(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleMcpMessage((entry ?? {}) as Record<string, unknown>))
      .filter((entry) => entry !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = handleMcpMessage((parsed ?? {}) as Record<string, unknown>);
  if (response === null) {
    res.writeHead(202, { 'X-GitHub-Request-Id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------
// HTTP router, auth, lifecycle
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type AuthState = 'owner' | 'stranger' | 'none';

/** Classify the request's bearer token; the first token ever presented becomes the owner's. */
function classifyAuth(req: IncomingMessage): AuthState {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return 'none';
  const token = header.slice('Bearer '.length);
  if (token === '') return 'none';
  if (ownerToken === null) {
    ownerToken = token;
    return 'owner';
  }
  return token === ownerToken ? 'owner' : 'stranger';
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': nextRequestId() });
    res.end('{"ok":true}');
    return;
  }

  const auth = classifyAuth(req);

  // MCP endpoint.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(200, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (auth === 'none') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (auth === 'stranger') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    handleMcp(res, raw);
    return;
  }

  // GraphQL endpoint.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (auth !== 'owner') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    handleGraphql(res, body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (auth === 'none') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    // Fast path for the single-issue read (the hottest REST route): skip the generic
    // segment machinery and serve the issue's cached serialization directly.
    if (method === 'GET' && auth === 'owner' && !url.search) {
      const fast = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
      if (fast) {
        const fastRepo = lookupRepo(decodeURIComponent(fast[1]), decodeURIComponent(fast[2]));
        if (fastRepo) {
          const fastIssue = fastRepo.issues.get(parseInt(fast[3], 10));
          if (!fastIssue) {
            restError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, issueJsonCached(fastRepo, fastIssue));
          return;
        }
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    handleRest(req, res, segments, url.searchParams, body, auth === 'stranger');
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (auth === 'none') {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (auth === 'stranger') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const repo = lookupRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3];
    try {
      if (endpoint === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Bad service' });
          return;
        }
        const protocol = req.headers['git-protocol'];
        const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
        handleInfoRefs(repo, service, isV2, res);
        return;
      }
      if (endpoint === 'git-upload-pack' && method === 'POST') {
        const raw = await readBody(req);
        const protocol = req.headers['git-protocol'];
        const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
        if (isV2) handleUploadPackV2(repo, raw, res);
        else handleUploadPackV0(repo, raw, res);
        return;
      }
      if (endpoint === 'git-receive-pack' && method === 'POST') {
        const raw = await readBody(req);
        handleReceivePack(repo, raw, res);
        return;
      }
    } catch {
      // A malformed request must never take the server down.
      if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
      else res.end();
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
  });
});
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;
server.requestTimeout = 120_000;

async function registerAndWait(port: number): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return;
  const base = envUrl.replace(/\/+$/, '');
  // Register the port, retrying with backoff (250 ms doubling to 2 s).
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) break;
    } catch {
      // The env is not up yet; keep retrying.
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(2000, delay * 2);
  }
  // Long-poll /done until the trial ends.
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body && body.done === true) break;
      }
    } catch {
      // A lost poll is not the end of the trial; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on port ${port}`);
  void registerAndWait(port);
});
