// Git object model and wire plumbing for the forge: SHA-1 addressed objects, loose-object hashing,
// pack reading (with ofs/ref delta resolution) and pack writing (whole objects only), pkt-line
// framing, and the reachability walks the smart-HTTP handlers answer from. Standard library only:
// node:crypto for SHA-1, node:zlib for the deflate streams packs and loose objects use.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The id of an object: SHA-1 of "<type> <size>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

/** One pkt-line: a 4-hex-digit length prefix (counting itself) over the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line too long: ${length}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** The largest payload one side-band pkt-line may carry (band byte plus the 4 length digits). */
export const SIDE_BAND_CHUNK = 65_520 - 5;

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole pkt-line stream; trailing bytes after the final flush are returned separately. */
export function decodePktLines(bytes: Buffer, start = 0): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: bytes.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

/** The data payloads of a packet list as text lines, without their trailing newlines. */
export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// commits and trees
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object into its header fields and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object from its parts, in git's canonical header order. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an object id through annotated tags until a non-tag object (or a missing object) is met. */
export function peelToCommit(
  lookup: (oid: string) => GitObject | undefined,
  oid: string,
): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object: "<mode> <name>\0<20-byte oid>" entries back to back. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare bytewise, directories as if they ended in "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Whether a tree entry is a subtree (mode 40000) rather than a blob. */
export function isTreeEntry(entry: TreeEntry): boolean {
  return entry.mode === '40000';
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

/** Apply a git delta buffer to its base bytes (copy/insert opcodes). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset]; offset += 1; }
      if (op & 0x02) { copyOffset |= delta[offset] << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= delta[offset] << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= delta[offset] << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset]; offset += 1; }
      if (op & 0x20) { copySize |= delta[offset] << 8; offset += 1; }
      if (op & 0x40) { copySize |= delta[offset] << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/** Inflate the zlib stream starting at `offset`; returns the data and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Read a pack entry header: the type code and uncompressed size, then where the stream starts. */
function readPackEntryHeader(buffer: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let byte = buffer[offset];
  offset += 1;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: offset };
}

/** Write a pack entry header for a whole (non-delta) object. */
function writePackEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_TO_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export interface PackEntry {
  oid: string;
  type: GitObjectType;
  data: Buffer;
}

/**
 * Parse a whole pack into its objects, resolving ofs-delta and ref-delta entries against bases in
 * the pack itself or, for a thin pack, the `resolveBase` lookup. Throws on any structural problem.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack: bad header');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    type: GitObjectType;
    data: Buffer;
  }
  const byOffset = new Map<number, RawEntry>();
  const objects = new Map<string, GitObject>();
  const pending: Array<{ offset: number; baseOid?: string; baseOffset?: number; delta: Buffer }> = [];

  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    if (header.typeCode === 6) {
      // ofs-delta: a negative-offset varint names the base entry.
      let byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryOffset, baseOffset: entryOffset - baseOffset, delta: inflated.data });
    } else if (header.typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryOffset, baseOid, delta: inflated.data });
    } else {
      const type = CODE_TO_TYPE[header.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${header.typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== header.size) throw new Error('pack object size mismatch');
      byOffset.set(entryOffset, { offset: entryOffset, type, data: inflated.data });
    }
  }

  const finish = (entry: RawEntry): void => {
    const oid = hashObject(entry.type, entry.data);
    objects.set(oid, { type: entry.type, data: entry.data });
  };
  for (const entry of byOffset.values()) finish(entry);

  // Resolve deltas in dependency order; each pass settles every delta whose base is now known.
  const byOffsetOid = new Map<number, string>();
  const rebuildIndex = (): void => {
    byOffsetOid.clear();
    for (const entry of byOffset.values()) byOffsetOid.set(entry.offset, hashObject(entry.type, entry.data));
  };
  rebuildIndex();
  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: typeof remaining = [];
    let progressed = false;
    for (const delta of remaining) {
      let base: GitObject | undefined;
      if (delta.baseOid !== undefined) {
        base = objects.get(delta.baseOid) ?? resolveBase?.(delta.baseOid);
      } else if (delta.baseOffset !== undefined) {
        const baseRaw = byOffset.get(delta.baseOffset);
        if (baseRaw !== undefined) base = { type: baseRaw.type, data: baseRaw.data };
      }
      if (base === undefined) {
        deferred.push(delta);
        continue;
      }
      const data = applyDelta(base.data, delta.delta);
      const entry: RawEntry = { offset: delta.offset, type: base.type, data };
      byOffset.set(delta.offset, entry);
      finish(entry);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing');
    remaining = deferred;
    rebuildIndex();
  }
  return objects;
}

/** Serialise objects into a pack of whole (never delta) entries with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from a commit: the commit, its trees and blobs, recursively. */
export function collectTreeClosure(lookup: ObjectLookup, commitOid: string, into: Set<string>): void {
  const commit = lookup(commitOid);
  if (commit === undefined || commit.type !== 'commit') return;
  const { tree } = parseCommit(commit.data);
  const walk = (treeOid: string): void => {
    if (into.has(treeOid)) return;
    const object = lookup(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    into.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (isTreeEntry(entry)) walk(entry.oid);
      else into.add(entry.oid);
    }
  };
  walk(tree);
}

export interface ClosureResult {
  /** Every object id in the closure (commits, tags, trees, blobs). */
  objects: Set<string>;
  /** Commits at the depth boundary: included, but their parents were cut off. */
  boundary: Set<string>;
  /** Generations of the included commits (1 = a want itself). */
  generations: Map<string, number>;
}

/**
 * The closure of `tips` following commit parents, with two cuts: commits in `cutAt` are treated as
 * parentless (a client's shallow boundary), and when `maxDepth` is set, commits deeper than it are
 * excluded and the ones at exactly that depth are reported as the boundary.
 */
export function commitClosure(
  lookup: ObjectLookup,
  tips: readonly string[],
  options: { cutAt?: ReadonlySet<string>; maxDepth?: number; minTimestamp?: number } = {},
): ClosureResult {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];

  const includeTagChain = (oid: string): string | null => {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = lookup(current);
      if (object === undefined) return null;
      objects.add(current);
      if (object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return null;
  };

  for (const tip of tips) {
    const commitOid = includeTagChain(tip);
    if (commitOid !== null && !generations.has(commitOid)) {
      generations.set(commitOid, 1);
      queue.push({ oid: commitOid, generation: 1 });
    }
  }

  while (queue.length > 0) {
    const { oid, generation } = queue.shift()!;
    const commit = lookup(oid);
    if (commit === undefined || commit.type !== 'commit') continue;
    objects.add(oid);
    collectTreeClosure(lookup, oid, objects);
    const view = parseCommit(commit.data);
    const { parents } = view;
    const cut = options.cutAt?.has(oid) === true;
    const atLimit = options.maxDepth !== undefined && generation >= options.maxDepth;
    const tsMatch = / (\d+) [+-]\d{4}$/.exec(view.committer);
    const tooOld = options.minTimestamp !== undefined
      && tsMatch !== null
      && parseInt(tsMatch[1], 10) < options.minTimestamp;
    if (parents.length > 0 && (cut || atLimit || tooOld)) boundary.add(oid);
    if (cut || atLimit || tooOld) continue;
    for (const parent of parents) {
      const known = generations.get(parent);
      if (known === undefined || known > generation + 1) {
        generations.set(parent, generation + 1);
        queue.push({ oid: parent, generation: generation + 1 });
      }
    }
  }
  return { objects, boundary, generations };
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors (the fast-forward test). */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

