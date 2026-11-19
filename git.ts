// github-forge git: git smart HTTP (protocol v2 upload-pack, v0 receive-pack)
// implemented from scratch on node:zlib / node:crypto. No git binary, no
// dependencies. Packs are emitted without deltas (plain objects); incoming
// packs may carry OFS_DELTA and REF_DELTA entries and are resolved on read.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  reachable,
  sha1Of,
  store,
  type GitObj,
  type ObjType,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export function pktLines(items: (string | Buffer | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'end') parts.push(PKT_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Split a buffer at the first flush pkt-line: [before, after]. */
export function splitAtFlush(buf: Buffer): { head: Buffer; tail: Buffer } {
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) return { head: buf.subarray(0, off), tail: buf.subarray(off + 4) };
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line');
    off += len;
  }
  return { head: buf, tail: Buffer.alloc(0) };
}

// -------------------------------------------------------------------------------------------
// git delta
// -------------------------------------------------------------------------------------------

function readDeltaSize(buf: Buffer, off: number): { size: number; next: number } {
  let size = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i]!;
    i += 1;
    size |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { size, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readDeltaSize(delta, off);
  off = src.next;
  const tgt = readDeltaSize(delta, off);
  off = tgt.next;
  if (src.size !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgt.size);
  let outOff = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off]! << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off]! << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outOff, cpOff, cpOff + cpSize);
      outOff += cpSize;
    } else if (op !== 0) {
      delta.copy(out, outOff, off, off + op);
      outOff += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outOff !== tgt.size) throw new Error('delta target size mismatch');
  return out;
}

// -------------------------------------------------------------------------------------------
// packfile reading / writing
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackVarint(buf: Buffer, off: number): { typeCode: number; size: number; next: number } {
  const first = buf[off]!;
  const typeCode = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (buf[i - 1]! & 0x80) {
    size |= (buf[i]! & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { typeCode, size, next: i };
}

function readOfsBase(buf: Buffer, off: number): { baseOffset: number; next: number } {
  let i = off;
  let b = buf[i]!;
  i += 1;
  let baseOffset = b & 0x7f;
  while (b & 0x80) {
    b = buf[i]!;
    i += 1;
    baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
  }
  return { baseOffset, next: i };
}

export interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a packfile into resolved objects. `resolveBase` supplies objects the pack references from outside. */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObj | undefined,
): { objects: Map<string, GitObj>; deltaCount: number } {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack checksum mismatch');
  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  let deltaCount = 0;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = off;
    const hdr = readPackVarint(pack, off);
    off = hdr.next;
    const entry: PackEntry = { offset: entryOffset, typeCode: hdr.typeCode, size: hdr.size, data: Buffer.alloc(0) };
    if (hdr.typeCode === 6) {
      const base = readOfsBase(pack, off);
      off = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
      deltaCount += 1;
    } else if (hdr.typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      deltaCount += 1;
    }
    const inflated = inflateAt(pack, off, trailerStart);
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  // Resolve in offset order (deltas may reference earlier entries only for OFS; REF may reference anything).
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: PackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: { type: ObjType; data: Buffer; oid: string };
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: { type: ObjType; data: Buffer; oid: string };
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base outside pack');
        base = resolve(baseEntry);
      } else {
        const byOid = [...resolved.values()].find((r) => r.oid === entry.baseOid);
        if (byOid) base = byOid;
        else {
          const ext = resolveBase?.(entry.baseOid!);
          if (!ext) throw new Error(`ref-delta base ${entry.baseOid} not available`);
          base = { type: ext.type, data: ext.data, oid: entry.baseOid! };
        }
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, oid: sha1Of(base.type, data) };
    } else {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error(`bad pack type ${entry.typeCode}`);
      result = { type, data: entry.data, oid: sha1Of(type, entry.data) };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, result);
    return result;
  };
  const objects = new Map<string, GitObj>();
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, deltaCount };
}

/** Inflate one zlib member starting at `off`; returns the data and the offset just past it. */
export function inflateAt(pack: Buffer, off: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(off, end), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesRead: number };
  };
  return { data: result.buffer, next: off + result.engine.bytesRead };
}

/** Build a packfile (version 2, no deltas) from objects. */
export function writePack(objects: Iterable<GitObj & { oid?: string }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const data = obj.data;
    const code = TYPE_CODE[obj.type];
    // varint header: first byte holds type in bits 4-6 and low 4 bits of size.
    const bytes: number[] = [];
    let size = data.length;
    bytes.push(((code & 0x07) << 4) | (size & 0x0f));
    size >>= 4;
    while (size > 0) {
      bytes[bytes.length - 1] |= 0x80;
      bytes.push(size & 0x7f);
      size >>= 7;
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === trailer;
}

// -------------------------------------------------------------------------------------------
// smart HTTP handlers
// -------------------------------------------------------------------------------------------

import { isAncestor, peelToCommit, filesAtCommit } from './store.ts';

export const AGENT = 'github-forge/1.0';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') {
    return 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  }
  return 'side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main';
}

/** A v0 ref advertisement body for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service);
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
  } else {
    const headLine = headTip !== '' ? `${headTip} HEAD\0${caps}\n` : null;
    if (headLine) lines.push(headLine);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        lines.push(`${peeled} ${name}^{}\n`);
      }
    }
    lines.push('flush');
  }
  return pktLines(lines as never);
}

/** A v2 capability advertisement body (no service preamble). */
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function lsRefsList(repo: Repo, prefixes: string[], wantPeel: boolean, wantSymrefs: boolean): LsRef[] {
  const out: LsRef[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headTip = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (headTip) out.push({ oid: headTip, name: 'HEAD', symrefTarget: wantSymrefs ? 'refs/heads/main' : undefined });
    else out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: wantSymrefs ? 'refs/heads/main' : undefined, unborn: true });
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const entry: LsRef = { oid, name };
    const obj = repo.objects.get(oid);
    if (wantPeel && obj && obj.type === 'tag') entry.peeled = peelToCommit(repo, oid);
    out.push(entry);
  }
  return out;
}

function lsRefLine(ref: LsRef): string {
  if (ref.unborn) {
    return `unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`;
  }
  let line = `${ref.oid} ${ref.name}`;
  if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
  if (ref.peeled) line += ` peeled:${ref.peeled}`;
  return `${line}\n`;
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send (in an order parents come after children is fine). */
  send: GitObj[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan a fetch: walk from `wants`, stop at `haves` and at existing shallow
 * boundaries, and honour `depth` (1 = tips only). Returns the objects to send
 * plus the shallow-info lines for the answer.
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  heldShallow: string[],
  depth: number | null,
): FetchPlan {
  // Expand what the client already holds: a client holding a commit holds
  // its whole history (for `have` lines) or just that commit and its tree
  // (for shallow boundaries, whose parents it does NOT have). Without this
  // expansion, trees/blobs shared with held history would be re-sent.
  const held = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (held.has(t)) continue;
      const tobj = repo.objects.get(t);
      if (!tobj) continue;
      held.add(t);
      if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) stack.push(e.oid);
    }
  };
  const addCommitClosure = (commitOid: string, withParents: boolean): void => {
    const stack = [commitOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) {
        held.add(oid);
        continue;
      }
      held.add(oid);
      if (obj.type !== 'commit') continue;
      addTreeClosure(parseCommit(obj.data).tree);
      if (withParents) for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
  };
  for (const h of haves) {
    // A `have` that is also a shallow boundary means "I have this commit
    // but NOT its parents" — expand only the commit and its tree. Other
    // haves carry their full history.
    addCommitClosure(h, !heldShallow.includes(h));
  }
  for (const s of heldShallow) addCommitClosure(s, false);

  const send = new Set<string>();
  const boundary = new Set<string>();
  const touched = new Set<string>();
  const visited = new Set<string>();

  const walkTree = (rootOid: string): void => {
    const treeQueue = [rootOid];
    while (treeQueue.length > 0) {
      const t = treeQueue.pop()!;
      if (visited.has(t) || held.has(t)) continue;
      visited.add(t);
      const tobj = repo.objects.get(t);
      if (!tobj) continue;
      send.add(t);
      if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) treeQueue.push(e.oid);
    }
  };

  // BFS by generation from the wants.
  const queue: { oid: string; dist: number }[] = wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      touched.add(oid);
      const c = parseCommit(obj.data);
      const atLimit = depth !== null && dist + 1 >= depth;
      if (atLimit && c.parents.length > 0) {
        // Parents are cut off: this commit is a new shallow boundary.
        boundary.add(oid);
      }
      if (!held.has(oid)) send.add(oid);
      walkTree(c.tree);
      if (depth === null) {
        // No depth limit: stop the walk at objects the client holds.
        if (held.has(oid)) continue;
        for (const p of c.parents) queue.push({ oid: p, dist: dist + 1 });
      } else if (!atLimit) {
        // Depth-limited: walk through held commits too, so a deepen past a
        // shallow boundary still delivers the parents.
        for (const p of c.parents) queue.push({ oid: p, dist: dist + 1 });
      }
    } else if (obj.type === 'tree') {
      walkTree(oid);
    } else if (obj.type === 'tag') {
      if (!held.has(oid)) send.add(oid);
      const target = parseTag(obj.data).object;
      if (!held.has(target)) queue.push({ oid: target, dist });
    }
  }
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const b of heldShallow) {
      // A held boundary is unshallowed when the walk reached it and all of
      // its parents are now being sent.
      if (!touched.has(b)) continue;
      const obj = repo.objects.get(b);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => send.has(p) || haves.has(p))) unshallow.push(b);
    }
  }
  const objects: GitObj[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { send: objects, shallow: [...boundary], unshallow };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (chunks <= 65515 data bytes: 4 header + 1 band + data <= 65520). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v2 fetch response body for a plan (acknowledgments + shallow-info + packfile). Non-final sections end with a delim packet, the packfile section with flush (protocol v2). The acknowledgments section is sent only when the client sent `have` lines (a real server omits it otherwise); it ACKs a held have, or NAKs when we hold none of them. */
export function v2FetchResponse(plan: FetchPlan, includePack: boolean, haves: Set<string> = new Set(), ackOid: string | null = null): Buffer {
  const sections: Buffer[] = [];
  if (haves.size > 0) {
    // In protocol v2, `ready` is its own line after the ACK(s); a bare
    // `ACK <oid> ready` suffix is not recognised by real git clients.
    sections.push(pktLines([ 'acknowledgments\n', ...(ackOid !== null ? [`ACK ${ackOid}\n`, 'ready\n'] : ['NAK\n']), 'delim' ]));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
    for (const s of plan.unshallow) lines.push(`unshallow ${s}\n`);
    sections.push(pktLines([...lines, 'delim']));
  }
  if (includePack) {
    const pack = writePack(plan.send);
    sections.push(pktLines(['packfile\n']));
    sections.push(sidebandPack(pack));
  }
  return Buffer.concat(sections);
}

/** A v0 fetch response body: NAK/ACK, shallow lines, then the sideband pack. */
export function v0FetchResponse(plan: FetchPlan, includePack: boolean, haves: Set<string> = new Set(), ackOid: string | null = null): Buffer {
  const parts: Buffer[] = [pktLine(haves.size > 0 && ackOid !== null ? `ACK ${ackOid}\n` : 'NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (includePack) {
    const pack = writePack(plan.send);
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack request body: command pkt-lines, then the raw pack. */
export function parseReceiveBody(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  const { head, tail } = splitAtFlush(body);
  const packets = decodePktLines(head);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, capabilities, pack: tail };
}

/**
 * Apply a push to a repo. Objects are already stored. Returns per-ref report
 * lines; fast-forward rules are enforced per ref and only ok refs move.
 */
export function applyPush(repo: Repo, commands: PushCommand[]): PushReportLine[] {
  const out: PushReportLine[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        out.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      out.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      out.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) {
      out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      out.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    out.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return out;
}

/** Build the report-status body, sideband-framed when requested. */
export function pushReportBody(lines: PushReportLine[], sideband: boolean): Buffer {
  const inner: (string | 'flush')[] = ['unpack ok\n'];
  for (const line of lines) {
    inner.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  inner.push('flush');
  const innerBuf = pktLines(inner as never);
  if (!sideband) return innerBuf;
  // Wrap the inner pkt-line stream in band-1 sideband packets (4 header + 1 band + data <= 65520).
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < innerBuf.length; off += CHUNK) {
    const slice = innerBuf.subarray(off, Math.min(innerBuf.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Store every object from a pack into the repo; returns false when the pack is unusable. */
export function storePack(repo: Repo, pack: Buffer): boolean {
  if (pack.length === 0) return true;
  try {
    if (!packChecksumOk(pack)) return false;
    const { objects } = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    return true;
  } catch {
    return false;
  }
}

export { filesAtCommit, reachable };

// -------------------------------------------------------------------------------------------
// smart HTTP endpoint handler (used by app.ts)
// -------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitJson(status: number, body: unknown): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(body), 'utf8') };
}

function pktTextLines(body: Buffer): string[] {
  const out: string[] = [];
  try {
    for (const pkt of decodePktLines(body)) {
      if (pkt.kind === 'data') out.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
    }
  } catch {
    // Malformed framing: treat as no lines; the caller answers without crashing.
  }
  return out;
}

/**
 * Handle one git smart-HTTP request. `service` is one of
 * `info/refs`, `git-upload-pack`, `git-receive-pack`. Returns the response
 * for app.ts to write (status, content-type, bytes).
 */
export function handleGit(
  method: string,
  owner: string,
  repoName: string,
  service: string,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return gitJson(404, { message: 'Not Found' });

  // GET /info/refs?service=git-upload-pack|git-receive-pack
  if (service === 'info/refs' && method === 'GET') {
    const requested = query.get('service') ?? '';
    const protocol = String(headers['git-protocol'] ?? '');
    if (requested === 'git-upload-pack') {
      if (protocol.includes('version=2')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
    }
    if (requested === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return gitJson(400, { message: 'Missing service parameter' });
  }

  // POST git-upload-pack: protocol v2 (command=...) or v0 (want/have).
  if (service === 'git-upload-pack' && method === 'POST') {
    const lines = pktTextLines(body);
    if (lines.length === 0) {
      // Malformed body: answer with an empty flush rather than crashing.
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: PKT_FLUSH };
    }
    const first = lines[0] ?? '';
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length);
      if (command === 'ls-refs') {
        const prefixes: string[] = [];
        let peel = false;
        let symrefs = false;
        for (const line of lines.slice(1)) {
          if (line === 'peel') peel = true;
          else if (line === 'symrefs') symrefs = true;
          else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
        }
        const refs = lsRefsList(repo, prefixes, peel, symrefs);
        const out = pktLines([...refs.map((r) => lsRefLine(r)), 'flush'] as never);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves = new Set<string>();
        const heldShallow: string[] = [];
        let depth: number | null = null;
        for (const line of lines.slice(1)) {
          if (line.startsWith('want ')) wants.push(line.slice(5).trim());
          else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
          else if (line.startsWith('shallow ')) heldShallow.push(line.slice(8).trim());
          else if (line.startsWith('deepen ')) {
            const n = Number(line.slice(7).trim());
            if (Number.isFinite(n) && n > 0) depth = n;
          }
        }
        const plan = planFetch(repo, wants, haves, heldShallow, depth);
        const ackOid = [...haves].find((h) => repo.objects.has(h)) ?? null;
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(plan, true, haves, ackOid) };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: PKT_FLUSH };
    }
    // Protocol v0: wants/shallow/deepen, flush, haves/done.
    const wants: string[] = [];
    const haves = new Set<string>();
    const heldShallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const oid = rest.split(' ')[0]!.trim();
        if (oid) wants.push(oid);
      } else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
      else if (line.startsWith('shallow ')) heldShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    const plan = planFetch(repo, wants, haves, heldShallow, depth);
    const ackOid = [...haves].find((h) => repo.objects.has(h)) ?? null;
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(plan, true, haves, ackOid) };
  }

  // POST git-receive-pack (v0 only).
  if (service === 'git-receive-pack' && method === 'POST') {
    let parsed;
    try {
      parsed = parseReceiveBody(body);
    } catch {
      return gitJson(400, { message: 'Invalid receive-pack request' });
    }
    if (parsed.pack.length > 0) storePack(repo, parsed.pack);
    const lines = applyPush(repo, parsed.commands);
    const sideband = parsed.capabilities.includes('side-band-64k');
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: pushReportBody(lines, sideband) };
  }

  return gitJson(404, { message: 'Not Found' });
}

