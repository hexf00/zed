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
// Needs @actions/cache resolved via NODE_PATH (installed by the workflow
// step: npm install --prefix "$RUNNER_TEMP/ccdeps" @actions/cache).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_ENTRIES = 16;
const MAX_BYTES = 32 * 1024 * 1024;
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
function walkStore() {
  const entries = new Map();
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
function groupChunks(entries) {
  const chunks = [];
  let group = [];
  let bytes = 0;
  for (const key of [...entries.keys()].sort()) {
    group.push(key);
    bytes += fs.statSync(entries.get(key)).size;
    if (group.length >= MAX_ENTRIES || bytes >= MAX_BYTES) {
      chunks.push({
        key: crypto.createHash("sha256").update(group.join("\n")).digest("hex"),
        members: group.slice(),
        bytes,
      });
      group = [];
      bytes = 0;
    }
  }
  if (group.length) {
    chunks.push({
      key: crypto.createHash("sha256").update(group.join("\n")).digest("hex"),
      members: group.slice(),
      bytes,
    });
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
  if (process.env.CHUNK_CACHE_DRYRUN) {
    console.log(`dryrun: would fetch ${index.chunks.length} chunks`);
    return;
  }
  const cache = require("@actions/cache");
  const missing = [];
  let chunksOk = 0;
  let entriesWritten = 0;
  const start = Date.now();
  for (const chunk of index.chunks) {
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
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(MISSING, missing.join("\n"));
  console.log(
    `chunk-fetch: chunks ${index.chunks.length} ok ${chunksOk} missing ${missing.length} ` +
      `entries written ${entriesWritten} in ${Math.round((Date.now() - start) / 1000)}s`,
  );
}

async function push() {
  const entries = walkStore();
  if (entries.size === 0) {
    throw new Error(`disk store ${STORE} is empty`);
  }
  const cache = process.env.CHUNK_CACHE_DRYRUN ? null : require("@actions/cache");
  const chunks = groupChunks(entries);
  const missing = fs.existsSync(MISSING)
    ? new Set(fs.readFileSync(MISSING, "utf8").split("\n").filter(Boolean))
    : new Set();
  const known = new Set(
    fs.existsSync(INDEX)
      ? JSON.parse(fs.readFileSync(INDEX, "utf8"))
          .chunks.map((c) => c.key)
          .filter((k) => !missing.has(k))
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
