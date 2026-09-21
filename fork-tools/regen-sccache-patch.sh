#!/usr/bin/env bash
# Regenerate fork-tools/sccache-extern-pe-normalize.patch from /tmp/a (pristine
# v0.18.0) and /tmp/b (fork tree). Fails loudly instead of committing an empty
# patch: `diff -ruN a b > f 2>/dev/null` writes a 0-byte file when a/ or b/ is
# missing, and diff exit 1 means "differences found", not failure.
set -euo pipefail
cd /tmp
[ -d a ] || { echo "FATAL: /tmp/a (pristine sccache) missing" >&2; exit 2; }
[ -d b ] || { echo "FATAL: /tmp/b (fork sccache tree) missing" >&2; exit 2; }
out="${1:-/root/code/zed-fork/fork-tools/sccache-extern-pe-normalize.patch}"
rm -f "$out"
rc=0
diff -ruN a b > "$out" || rc=$?
[ "$rc" -eq 1 ] || { echo "FATAL: diff rc=$rc (want 1)" >&2; exit 2; }
[ -s "$out" ] || { echo "FATAL: patch is empty" >&2; exit 2; }
for m in hash_all_externs normalize_pe_volatile_bytes 0.18.0-fork.1; do
  grep -q "$m" "$out" || { echo "FATAL: marker '$m' missing from patch" >&2; exit 2; }
done
grep -q '^diff -ruN a/Cargo.toml b/Cargo.toml' "$out" || { echo "FATAL: a/ b/ headers wrong" >&2; exit 2; }
echo "ok: $(wc -l < "$out") lines -> $out"
