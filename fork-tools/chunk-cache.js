// Chunked transport for the sccache disk store (L0) over the GHA cache.
//
// Why: per-entry GHA requests throttle on metadata rate limits (~1500
// downloads/min, 200 uploads/min per repo). Entries travel in
// content-addressed chunks (<=16 entries and <=32 MiB each): the chunk key
// is sha256 over its sorted member keys, so an unchanged chunk keeps its
// GHA cache entry and "update by chunk" only uploads new/changed chunks.
// A stale or evicted chunk costs prefetch bandwidth at worst; entries
// missing from every indexed chunk still fall back to the normal
// per-entry GHA path during the build.
//
// Usage: node chunk-cache.js fetch|push
//   fetch: download every chunk listed in .sccache-chunkindex/chunks.json
//          and move member files into .sccache-disk (L0 shard layout
//          <k0>/<k1>/<key>). Chunk keys that GHA no longer has are
//          reported to .sccache-chunkindex/missing.txt so the next push
//          re-uploads them (self-healing after eviction).
//   push:  pack .sccache-disk into chunks, upload the ones the index does
//          not list yet, write the merged index back to chunks.json.
//
// Needs the @actions/cache package (see fork-tools/package.json), resolved
// from fork-tools/node_modules. The modern major is ESM-only and its
// restore uses the V2 cache service (ACTIONS_RESULTS_URL); the old v3
// restore needed the retired V1 ACTIONS_CACHE_URL and silently missed
// every entry ("Cache Service Url not found"), which is why this file
// uses dynamic import instead of require.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ESM-only package: load lazily via dynamic import so the module also
// works for the dry-run path and local tests that never touch the API.
async function loadCache() {
  return import("@actions/cache");
}

// Chunking scheme v2: content-anchored cuts. A chunk ends after a key whose
// sha256 starts with 0000xxxx (~1/16 of keys), so cut positions depend on
// individual keys, not running counts: inserting N keys re-chunks ~N chunks
// instead of every chunk after the first insertion (the fixed-16 sequential
// scheme made a 14-entry drift re-push ~160 chunks). Hard caps are a safety
// net for anchor-free stretches. SCHEME prefixes every chunk key; bumping it
// invalidates all chunks at once (old keys are pruned from the index on the
// next push, so old and new schemes never co-pull).
const SCHEME = "v2-";
const ANCHOR_MASK = 0xf0;
const MAX_ENTRIES = 24;
const MAX_BYTES = 48 * 1024 * 1024;
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
const STORE = path.join(WORKSPACE, ".sccache-disk");
const INDEX_DIR = path.join(WORKSPACE, ".sccache-chunkindex");
const INDEX = path.join(INDEX_DIR, "chunks.json");
const MISSING = path.join(INDEX_DIR, "missing.txt");
const STAGING = path.join(WORKSPACE, ".sccache-chunks");

// @actions/cache archives restore into the exact relative path it was
// saved from, so fetch and push must stage under the same workspace path.
const stagingDir = (key) => path.join(STAGING, key);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// DiskCache layout is <store>/<key[0..1]>/<key[1..2]>/<key>; entry files
// are named by their 64-hex key.
function walkStore() {  const entries = new Map();
  if (!fs.existsSync(STORE)) return entries;
  for (const l0 of fs.readdirSync(STORE, { withFileTypes: true })) {
    if (!l0.isDirectory()) continue;
    for (const l1 of fs.readdirSync(path.join(STORE, l0.name), { withFileTypes: true })) {
      if (!l1.isDirectory()) continue;
      for (const e of fs.readdirSync(path.join(STORE, l0.name, l1.name), { withFileTypes: true })) {
        if (e.isFile() && /^[0-9a-f]{64}$/.test(e.name)) {
          entries.set(e.name, path.join(STORE, l0.name, l1.name, e.name));
        }
      }
    }
  }
  return entries;
}

// Sorted keys make grouping deterministic: the same membership always
// produces the same chunks on every runner.
function isAnchor(key) {
  return (crypto.createHash("sha256").update(key).digest()[0] & ANCHOR_MASK) === 0;
}

function groupChunks(entries) {
  const chunks = [];
  let group = [];
  let bytes = 0;
  const cut = () => {
    chunks.push({
      key: SCHEME + crypto.createHash("sha256").update(group.join("\n")).digest("hex"),
      members: group.slice(),
      bytes,
    });
    group = [];
    bytes = 0;
  };
  for (const key of [...entries.keys()].sort()) {
    group.push(key);
    bytes += fs.statSync(entries.get(key)).size;
    if (isAnchor(key) || group.length >= MAX_ENTRIES || bytes >= MAX_BYTES) {
      cut();
    }
  }
  if (group.length) {
    cut();
  }
  return chunks;
}

function moveIntoStore(srcPath, key) {
  const dst = path.join(STORE, key[0], key[1], key);
  if (fs.existsSync(dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(srcPath, dst);
  } catch {
    fs.copyFileSync(srcPath, dst);
    fs.rmSync(srcPath, { force: true });
  }
  return true;
}

async function fetch() {
  if (!fs.existsSync(INDEX)) {
    console.log(
      "no chunk index yet - skipping fetch (bank run backfills via GHA, then pushes chunks)",
    );
    return;
  }
  const index = JSON.parse(fs.readFileSync(INDEX, "utf8"));
  // Chunks from an older scheme are pruned on the next push; never pull them.
  const current = index.chunks.filter((c) => c.key.startsWith(SCHEME));
  const stale = index.chunks.length - current.length;
  if (stale > 0) console.log(`skipping ${stale} chunks from an older scheme`);
  if (process.env.CHUNK_CACHE_DRYRUN) {
    console.log(`dryrun: would fetch ${current.length} chunks`);
    return;
  }
  const cache = await loadCache();
  const missing = [];
  let chunksOk = 0;
  let entriesWritten = 0;
  const start = Date.now();

  // Independent staging dirs per chunk: safe to restore in parallel; the
  // wall time of ~260 chunk downloads drops roughly by the pool size.
  const CONCURRENCY = 16;
  let cursor = 0;
  async function worker() {
    while (cursor < current.length) {
      const chunk = current[cursor++];
      const staging = stagingDir(chunk.key);
      rmrf(staging);
      fs.mkdirSync(staging, { recursive: true });
      let hit = null;
      try {
        hit = await cache.restoreCache([staging], chunk.key);
      } catch (err) {
        console.log(`restore ${chunk.key} failed: ${err.message}`);
      }
      if (!hit) {
        missing.push(chunk.key);
        rmrf(staging);
        continue;
      }
      for (const f of fs.readdirSync(staging)) {
        if (/^[0-9a-f]{64}$/.test(f) && moveIntoStore(path.join(staging, f), f)) {
          entriesWritten += 1;
        }
      }
      rmrf(staging);
      chunksOk += 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(MISSING, missing.sort().join("\n"));
  console.log(
    `chunk-fetch: chunks ${current.length} ok ${chunksOk} missing ${missing.length} ` +
      `entries written ${entriesWritten} in ${Math.round((Date.now() - start) / 1000)}s`,
  );
}

async function push() {
  const entries = walkStore();
  if (entries.size === 0) {
    throw new Error(`disk store ${STORE} is empty`);
  }
  const cache = process.env.CHUNK_CACHE_DRYRUN ? null : await loadCache();
  const chunks = groupChunks(entries);
  const missing = fs.existsSync(MISSING)
    ? new Set(fs.readFileSync(MISSING, "utf8").split("\n").filter(Boolean))
    : new Set();
  const known = new Set(
    fs.existsSync(INDEX)
      ? JSON.parse(fs.readFileSync(INDEX, "utf8"))
          .chunks.map((c) => c.key)
          .filter((k) => k.startsWith(SCHEME) && !missing.has(k))
      : [],
  );
  let pushed = 0;
  let reused = 0;
  const failedKeys = new Set();
  const start = Date.now();
  for (const chunk of chunks) {
    if (known.has(chunk.key)) {
      reused += 1;
      continue;
    }
    const staging = stagingDir(chunk.key);
    rmrf(staging);
    fs.mkdirSync(staging, { recursive: true });
    for (const key of chunk.members) {
      fs.copyFileSync(entries.get(key), path.join(staging, key));
    }
    if (!cache) {
      console.log(`dryrun: would save ${chunk.key} (${chunk.members.length} entries, ${chunk.bytes} bytes)`);
    } else {
      try {
        await cache.saveCache([staging], chunk.key);
        pushed += 1;
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (/already exists|Reservation/i.test(msg)) {
          reused += 1;
        } else {
          // One failed chunk must not lose the whole index: exclude it so
          // the next run re-pushes it.
          console.log(`save ${chunk.key} failed: ${msg}`);
          failedKeys.add(chunk.key);
          rmrf(staging);
          continue;
        }
      }
    }
    rmrf(staging);
    known.add(chunk.key);
  }
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  // The index describes current full membership; keys GHA evicted were
  // pruned via missing.txt, and their chunks are re-pushed above.
  fs.writeFileSync(
    INDEX,
    JSON.stringify(
      {
        version: 1,
        chunks: chunks
          .filter((c) => !failedKeys.has(c.key))
          .map(({ key, members, bytes }) => ({ key, members: members.length, bytes })),
      },
      null,
      1,
    ),
  );
  console.log(
    `chunk-push: chunks ${chunks.length} pushed ${pushed} reused ${reused} failed ${failedKeys.size} ` +
      `in ${Math.round((Date.now() - start) / 1000)}s`,
  );
}

if (require.main === module) {
  (async () => {
    const mode = process.argv[2];
    if (mode === "fetch") await fetch();
    else if (mode === "push") await push();
    else throw new Error(`usage: node chunk-cache.js fetch|push (got: ${mode})`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { walkStore, groupChunks };
