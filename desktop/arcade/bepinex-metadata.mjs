// Bounded ECMA-335 metadata inspection. Never loads an assembly or evaluates
// attribute constructors. Framework identity is resolved through AssemblyRef.
const coded = {
  resolution: [2, [0, 26, 35, 1]], type: [2, [2, 1, 27]],
  constant: [2, [4, 8, 23]], attribute: [5, [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43]],
  marshal: [1, [4, 8]], security: [2, [2, 6, 32]], member: [3, [2, 1, 26, 6, 27]],
  semantics: [1, [20, 23]], method: [1, [6, 10]], forwarded: [1, [4, 6]],
  implementation: [2, [38, 35, 39]], constructor: [3, [-1, -1, 6, 10]], owner: [1, [2, 6]],
};
// Numeric fields are byte widths; tN is a table index; named fields are coded.
const schemas = [
  [2, "s", "g", "g", "g"], ["resolution", "s", "s"], [4, "s", "s", "type", "t4", "t6"],
  ["t4"], [2, "s", "b"], ["t6"], [4, 2, 2, "s", "b", "t8"], ["t8"], [2, 2, "s"],
  ["t2", "type"], ["member", "s", "b"], [2, "constant", "b"], ["attribute", "constructor", "b"],
  ["marshal", "b"], [2, "security", "b"], [2, 4, "t2"], [4, "t4"], ["b"], ["t2", "t20"],
  ["t20"], [2, "s", "type"], ["t2", "t23"], ["t23"], [2, "s", "b"],
  [2, "t6", "semantics"], ["t2", "method", "method"], ["s"], ["b"], [2, "forwarded", "s", "t26"],
  [4, "t4"], [4, 4], [4], [4, 2, 2, 2, 2, 4, "b", "s", "s"], [4], [4, 4, 4],
  [2, 2, 2, 2, 4, "b", "s", "s", "b"], [4, "t35"], [4, 4, 4, "t35"], [4, "s", "b"],
  [4, 4, "s", "s", "implementation"], [4, 4, "s", "implementation"], ["t2", "t2"],
  [2, 2, "owner", "s"], ["method", "b"], ["t42", "type"],
];
const fail = text => { throw new Error(`Managed plugin metadata: ${text}`); };
export function inspectBepInExAssembly(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > 16 * 1024 * 1024 || bytes.length < 256) fail("invalid assembly size.");
  const bounds = (offset, size, end = bytes.length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || offset + size > end) fail("out-of-range metadata.");
  };
  const u16 = offset => { bounds(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { bounds(offset, 4); return bytes.readUInt32LE(offset); };
  if (u16(0) !== 0x5a4d) fail("not a PE assembly.");
  const pe = u32(60); if (u32(pe) !== 0x4550) fail("invalid PE signature.");
  const count = u16(pe + 6), optional = pe + 24, optionalSize = u16(pe + 20), magic = u16(optional);
  const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : fail("unsupported PE format.");
  if (!count || count > 96 || optionalSize < directories + 15 * 8) fail("missing CLI header.");
  bounds(optional, optionalSize + count * 40);
  const rva = (address, size) => {
    if (address < u32(optional + 60)) { bounds(address, size); return address; }
    for (let index = 0; index < count; index++) {
      const section = optional + optionalSize + index * 40;
      const start = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20);
      if (address >= start && address - start + size <= rawSize) {
        const offset = raw + address - start; bounds(offset, size); return offset;
      }
    }
    fail("unmapped CLI address.");
  };
  const cli = rva(u32(optional + directories + 14 * 8), 24), flags = u32(cli + 16);
  if (!(flags & 1) || flags & (2 | 0x10)) fail("only IL-only, x64-compatible managed assemblies are admitted.");
  const metadataSize = u32(cli + 12), metadata = rva(u32(cli + 8), metadataSize), end = metadata + metadataSize;
  if (u32(metadata) !== 0x424a5342) fail("missing CLR metadata signature.");
  const align = n => (n + 3) & ~3;
  let position = metadata + 16 + align(u32(metadata + 12));
  bounds(position, 4, end);
  const streamCount = u16(position + 2); position += 4;
  if (!streamCount || streamCount > 16) fail("invalid stream count.");
  const streams = {};
  for (let i = 0; i < streamCount; i++) {
    bounds(position, 9, end);
    const start = metadata + u32(position), length = u32(position + 4);
    let stop = position + 8; while (stop < end && stop - position < 40 && bytes[stop]) stop++;
    if (stop >= end || bytes[stop]) fail("unterminated stream name.");
    const name = bytes.toString("ascii", position + 8, stop);
    if (Object.hasOwn(streams, name)) fail("duplicate stream.");
    bounds(start, length, end); streams[name] = { start, end: start + length };
    position = align(stop + 1 - metadata) + metadata;
  }
  const table = streams["#~"] ?? streams["#-"], strings = streams["#Strings"], blobs = streams["#Blob"];
  if (!table || !strings || !blobs) fail("missing metadata heaps.");
  for (const stream of Object.values(streams)) if (stream.start < position) fail("stream overlaps metadata header.");
  const ordered = Object.values(streams).filter(stream => stream.end > stream.start).sort((a, b) => a.start - b.start);
  if (ordered.some((stream, i) => i && stream.start < ordered[i - 1].end)) fail("overlapping metadata streams.");
  bounds(table.start, 24, table.end);
  const heaps = bytes[table.start + 6], valid = bytes.readBigUInt64LE(table.start + 8);
  const rows = Array(64).fill(0), offsets = [], sizes = [], widths = [];
  position = table.start + 24; let total = 0;
  for (let id = 0; id < 64; id++) if (valid & (1n << BigInt(id))) {
    bounds(position, 4, table.end); rows[id] = u32(position); position += 4;
    total += rows[id];
    if (!schemas[id] || total > 200000) fail("unsupported or excessive metadata tables.");
  }
  const width = field => {
    if (typeof field === "number") return field;
    if (field === "s" || field === "g" || field === "b") return heaps & ({ s: 1, g: 2, b: 4 }[field]) ? 4 : 2;
    if (field.startsWith("t")) return rows[Number(field.slice(1))] >= 65536 ? 4 : 2;
    const [bits, ids] = coded[field]; return Math.max(...ids.map(id => rows[id] ?? 0)) >= 2 ** (16 - bits) ? 4 : 2;
  };
  for (let id = 0; id < 45; id++) {
    widths[id] = schemas[id].map(width); sizes[id] = widths[id].reduce((a, b) => a + b, 0);
    offsets[id] = position; bounds(position, sizes[id] * rows[id], table.end); position += sizes[id] * rows[id];
  }
  const row = (id, index) => {
    if (!index || index > rows[id]) fail("invalid table reference.");
    let offset = offsets[id] + (index - 1) * sizes[id];
    return widths[id].map(size => { const value = size === 2 ? u16(offset) : u32(offset); offset += size; return value; });
  };
  const string = index => {
    const start = strings.start + index; bounds(start, 1, strings.end);
    let stop = start; while (stop < strings.end && stop - start < 2048 && bytes[stop]) stop++;
    if (stop === strings.end || bytes[stop]) fail("unbounded metadata string.");
    return bytes.toString("utf8", start, stop);
  };
  const compressed = (buffer, cursor) => {
    if (cursor.at >= buffer.length) fail("truncated compressed integer.");
    const first = buffer[cursor.at++];
    let value, count;
    if (first < 128) return first;
    if ((first & 0xc0) === 0x80) { value = first & 0x3f; count = 1; }
    else if ((first & 0xe0) === 0xc0) { value = first & 0x1f; count = 3; }
    else fail("invalid compressed integer.");
    while (count--) { if (cursor.at >= buffer.length) fail("truncated integer."); value = value * 256 + buffer[cursor.at++]; }
    return value;
  };
  const blob = index => {
    const cursor = { at: blobs.start + index }, length = compressed(bytes.subarray(0, blobs.end), cursor);
    bounds(cursor.at, length, blobs.end); if (length > 16384) fail("oversized attribute.");
    return bytes.subarray(cursor.at, cursor.at + length);
  };
  const reference = index => {
    const type = row(1, index), scope = type[0];
    if ((scope & 3) !== 2 || string(row(35, scope >>> 2)[6]) !== "BepInEx") return null;
    return `${string(type[2])}.${string(type[1])}`;
  };
  const extendsPlugin = (index, seen = new Set()) => {
    if (seen.has(index) || seen.size > 32) fail("invalid inheritance chain.");
    seen.add(index);
    const parent = row(2, index)[3];
    return (parent & 3) === 1 ? reference(parent >>> 2) === "BepInEx.BaseUnityPlugin" :
      (parent & 3) === 0 && parent >>> 2 ? extendsPlugin(parent >>> 2, seen) : false;
  };
  const attributes = new Map();
  for (let i = 1; i <= rows[12]; i++) {
    const [owner, constructor, value] = row(12, i);
    if ((owner & 31) !== 3 || (constructor & 7) !== 3) continue; // TypeDef, MemberRef
    const member = row(10, constructor >>> 3);
    if ((member[0] & 7) !== 1 || string(member[1]) !== ".ctor") continue;
    const name = reference(member[0] >>> 3);
    if (!["BepInEx.BepInPlugin", "BepInEx.BepInDependency", "BepInEx.BepInIncompatibility", "BepInEx.BepInProcess"].includes(name)) continue;
    const target = owner >>> 5, list = attributes.get(target) ?? [];
    if (list.length >= 193) fail("too many framework attributes on one class.");
    list.push({ name, value: blob(value), signature: blob(member[2]) }); attributes.set(target, list);
  }
  const plugins = [];
  const safeId = id => { if (!/^[A-Za-z0-9_.-]{1,200}$/.test(id)) fail("invalid plugin GUID."); return id; };
  const version = value => { if (!/^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(value)) fail("unsupported plugin version."); return value; };
  for (const [type, list] of attributes) {
    const definitions = list.filter(attr => attr.name === "BepInEx.BepInPlugin");
    if (!definitions.length) continue;
    if (definitions.length !== 1 || !extendsPlugin(type) || row(2, type)[0] & 0x80) fail("plugin class must concretely inherit BaseUnityPlugin.");
    const requires = [], incompatible = [], processes = []; let plugin;
    for (const attr of list) {
      const value = attr.value, cursor = { at: 2 };
      if (value.length < 4 || value.readUInt16LE(0) !== 1) fail("invalid attribute prolog.");
      const text = () => {
        const length = compressed(value, cursor);
        if (length > 1024 || cursor.at + length > value.length) fail("invalid attribute string.");
        const result = value.toString("utf8", cursor.at, cursor.at + length); cursor.at += length; return result;
      };
      if (attr.name === "BepInEx.BepInPlugin") {
        const id = safeId(text()), name = text(), ver = version(text());
        if (!name || name.length > 256 || /[\0-\x1f]/.test(name)) fail("invalid plugin name.");
        plugin = { id, name, version: ver, requires, incompatible, processes };
      } else if (attr.name === "BepInEx.BepInDependency") {
        const id = safeId(text()), signature = attr.signature, sig = { at: 1 };
        const parameters = compressed(signature, sig);
        if (parameters !== 2 || signature[sig.at++] !== 1 || signature[sig.at++] !== 0x0e) fail("unsupported dependency constructor.");
        const second = signature[sig.at];
        if (second === 0x0e) requires.push({ id, minimum: version(text()), soft: false });
        else if (second === 0x11 && cursor.at + 4 <= value.length) {
          const flags = value.readUInt32LE(cursor.at); cursor.at += 4;
          if (![1, 2].includes(flags)) fail("unsupported dependency flags.");
          requires.push({ id, minimum: null, soft: flags === 2 });
        } else fail("unsupported dependency signature.");
      } else if (attr.name === "BepInEx.BepInIncompatibility") incompatible.push(safeId(text()));
      else {
        const process = text(); if (!process || /[\0-\x1f\\/]/.test(process)) fail("invalid process restriction.");
        processes.push(process);
      }
      if (cursor.at + 2 !== value.length || value.readUInt16LE(cursor.at) !== 0) fail("named attribute overrides need explicit support.");
    }
    if (plugins.some(item => item.id === plugin.id)) fail("duplicate plugin GUID.");
    if (plugins.length >= 64 || requires.length > 64 || incompatible.length > 64 || processes.length > 64) fail("plugin declarations exceed inspection limits.");
    plugins.push(plugin);
  }
  if (rows[32] !== 1) fail("expected one assembly identity.");
  const assembly = row(32, 1), name = string(assembly[7]);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
    fail("unsafe/reserved Windows assembly name.");
  return { assembly: name, version: assembly.slice(1, 5).join("."), plugins };
}
