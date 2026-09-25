import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWisp } from './kernel.mjs';

// mock fetch: a tiny in-memory "GitHub" — deterministic, no real network needed to prove the logic.
function mockFetch(files) {
  return async (url) => {
    const m = url.match(/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    const path = m ? decodeURIComponent(m[1]) : null;
    if (!path || !(path in files)) return { ok: false };
    return { ok: true, json: async () => ({ content: Buffer.from(files[path], 'utf8').toString('base64') }) };
  };
}

test('all three claims real -> PASS 3/3', async () => {
  const fetchImpl = mockFetch({ 'kernel.mjs': 'code', 'kernel.test.mjs': 'tests', 'README.md': 'built and gated, witness 33/33 clean' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'kernel.mjs', claimedGateCompanion: 'kernel.test.mjs', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 'witness 33/33 clean' }, fetchImpl);
  assert.equal(r.decision, 'PASS');
  assert.equal(r.score, '3/3');
  assert.deepEqual(r.failedChecks, []);
});

test('claimed file does not exist -> FLAG, names the failed check', async () => {
  const fetchImpl = mockFetch({ 'kernel.test.mjs': 'tests', 'README.md': 'x' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'does-not-exist.mjs', claimedGateCompanion: 'kernel.test.mjs', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 'x' }, fetchImpl);
  assert.equal(r.decision, 'FLAG');
  assert.ok(r.failedChecks.includes('provenance'));
});

test('claimed gate-companion does not exist -> FLAG, even though the source file is real', async () => {
  const fetchImpl = mockFetch({ 'kernel.mjs': 'code', 'README.md': 'x' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'kernel.mjs', claimedGateCompanion: 'fake-tests.mjs', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 'x' }, fetchImpl);
  assert.equal(r.decision, 'FLAG');
  assert.ok(r.failedChecks.includes('gate-companion'));
  assert.equal(r.provenanceReal, true); // the other real check still reports true — precise, not blanket
});

test('THE HARD CASE: file and gate both real, but the specific cross-referenced claim is fabricated -> FLAG, no partial credit', async () => {
  const fetchImpl = mockFetch({ 'kernel.mjs': 'code', 'kernel.test.mjs': 'tests', 'README.md': 'built and gated, ordinary readme text' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'kernel.mjs', claimedGateCompanion: 'kernel.test.mjs', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 'proves the shadow-tuning hypothesis conclusively' }, fetchImpl);
  assert.equal(r.decision, 'FLAG');
  assert.equal(r.score, '2/3');
  assert.deepEqual(r.failedChecks, ['cross-reference']);
});

test('a network failure on any check is treated as a failed check, never throws', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'a', claimedGateCompanion: 'b', claimedCrossRefFile: 'c', claimedCrossRefPhrase: 'd' }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'FLAG');
  assert.equal(r.score, '0/3');
});

test('a 404-style response (ok:false) is a clean failed check, not a crash', async () => {
  const fetchImpl = async () => ({ ok: false });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'a', claimedGateCompanion: 'b', claimedCrossRefFile: 'c', claimedCrossRefPhrase: 'd' }, fetchImpl);
  assert.equal(r.decision, 'FLAG');
});

test('garbage/missing input refuses cleanly', async () => {
  for (const bad of [undefined, null, '', 123, {}]) {
    const r = await verifyWisp({ owner: bad, repo: 'y' }, mockFetch({}));
    assert.equal(r.ok, false);
  }
  for (const bad of [undefined, null, '', 123, {}]) {
    const r = await verifyWisp({ owner: 'x', repo: bad }, mockFetch({}));
    assert.equal(r.ok, false);
  }
});

test('a truthy NON-STRING claimedFile (e.g. a number) never throws -- isolates the typeof-then-.trim() guard from a mutation that would call .trim() on a non-string', async () => {
  const fetchImpl = mockFetch({});
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 123, claimedGateCompanion: 456, claimedCrossRefFile: 789, claimedCrossRefPhrase: 'x' }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.decision, 'FLAG');
});

test('a truthy NON-STRING claimedCrossRefPhrase (with a valid string file) never throws -- isolates the phrase-side typeof/.trim() clauses specifically', async () => {
  const fetchImpl = mockFetch({ 'README.md': 'x' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 123 }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.crossReferenced, false);
});

test('claimedCrossRefFile exists but its response is missing .content -- never throws, cross-reference stays false', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) }); // no .content field
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedCrossRefFile: 'README.md', claimedCrossRefPhrase: 'x' }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.crossReferenced, false);
});

test('a fetch that resolves to null/undefined (not just ok:false) never throws -- isolates the !r check from !r.ok on a null response', async () => {
  const fetchImpl = async () => null;
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'a' }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.provenanceReal, false);
});

test('omitted optional claim fields (no cross-ref requested) simply do not count toward score, refuse gracefully', async () => {
  const fetchImpl = mockFetch({ 'kernel.mjs': 'code', 'kernel.test.mjs': 'tests' });
  const r = await verifyWisp({ owner: 'x', repo: 'y', claimedFile: 'kernel.mjs', claimedGateCompanion: 'kernel.test.mjs' }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.crossReferenced, false);
  assert.equal(r.score, '2/3');
  assert.equal(r.decision, 'FLAG'); // still an honest FLAG — 2/3 is not PASS, no rounding up
});
