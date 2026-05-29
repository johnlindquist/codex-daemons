import { test, expect, afterAll } from "bun:test";
import { sourceFingerprint, metaPath, socketPath } from "../lib/daemon.ts";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Build a throwaway "repo" layout: <dir>/daemons/pro-x + <dir>/lib/*.ts so that
// sourceFingerprint() (which hashes argv[1] + sibling ../lib/*.ts) has files to read.
const root = mkdtempSync(join(tmpdir(), "hotreload-"));
const daemonsDir = join(root, "daemons");
const libDir = join(root, "lib");
mkdirSync(daemonsDir, { recursive: true });
mkdirSync(libDir, { recursive: true });

const exe = join(daemonsDir, "pro-x");
const lib = join(libDir, "isolated.ts");
writeFileSync(exe, "// daemon v1\n");
writeFileSync(lib, "// lib v1\n");

const origArgv1 = process.argv[1];
process.argv[1] = exe;
afterAll(() => {
  process.argv[1] = origArgv1;
  rmSync(root, { recursive: true, force: true });
});

test("fingerprint is deterministic for unchanged source", () => {
  expect(sourceFingerprint()).toBe(sourceFingerprint());
});

test("editing the executable changes the fingerprint", () => {
  const before = sourceFingerprint();
  writeFileSync(exe, "// daemon v2 (edited instructions/model)\n");
  expect(sourceFingerprint()).not.toBe(before);
});

test("editing a lib file changes the fingerprint", () => {
  const before = sourceFingerprint();
  writeFileSync(lib, "// lib v2 (shared change affects all daemons)\n");
  expect(sourceFingerprint()).not.toBe(before);
});

test("editing the self-improvement lessons overlay changes the fingerprint", () => {
  // A Stop hook appends to `<exe>.lessons.md`; the next prompt must hot-reload.
  const lessons = `${exe}.lessons.md`;
  const before = sourceFingerprint();
  writeFileSync(lessons, "- learned: read stderr before retrying\n");
  expect(sourceFingerprint()).not.toBe(before);
});

test("meta and socket paths are namespaced per profile", () => {
  expect(metaPath("pro-x")).toContain("pro-x");
  expect(metaPath("pro-x")).not.toBe(socketPath("pro-x"));
});
