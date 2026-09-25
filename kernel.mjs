#!/usr/bin/env node
// kernel.mjs — WISP: the real, deterministic, no-LLM-judge output-claim verifier. Given a claim
// about a public GitHub repo (a source file, a gate/test companion file, a cross-referenced file +
// phrase), checks each against GitHub's own real, public, unauthenticated REST API — no server, no
// key, independently re-runnable by anyone, not just trusting a local filesystem (which a static
// page can't read anyway — that's WHY this targets a public repo instead of local paths: the honest
// form that can actually ship as a page).
//
// Verifies exactly three things, and only these three — never claims to detect "all confabulation":
//   1. provenanceReal  — does the claimed source file genuinely exist in the repo?
//   2. gateBacked       — does a claimed companion gate/test file genuinely exist alongside it?
//   3. crossReferenced  — does a claimed cross-reference file genuinely CONTAIN the claimed phrase?
// PASS requires all three; anything less is FLAG, with each failing check named.
//
// `fetchImpl` is injected (defaults to the global fetch) so this is genuinely testable without a
// real network call — the same injectable-dependency idiom used all night (consent-gate's clock,
// strand's clock). Total: never throws; a network failure or missing file is just a failed check.

async function ghFileExists(owner, repo, path, fetchImpl) {
  if (!path) return { exists: false };
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!r || !r.ok) return { exists: false };
    const j = await r.json();
    return { exists: true, json: j };
  } catch { return { exists: false }; }
}

function b64ToText(b64) {
  if (typeof atob === 'function') return atob(b64.replace(/\n/g, ''));
  return Buffer.from(b64.replace(/\n/g, ''), 'base64').toString('utf8'); // Node fallback for the test/CLI path
}

export async function verifyWisp({ owner, repo, claimedFile, claimedGateCompanion, claimedCrossRefFile, claimedCrossRefPhrase }, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  if (typeof owner !== 'string' || !owner.trim()) return { ok: false, why: 'owner must be a non-empty string' };
  if (typeof repo !== 'string' || !repo.trim()) return { ok: false, why: 'repo must be a non-empty string' };
  if (typeof fetchImpl !== 'function') return { ok: false, why: 'no fetch implementation available' };

  const fileCheck = typeof claimedFile === 'string' && claimedFile.trim() ? await ghFileExists(owner, repo, claimedFile, fetchImpl) : { exists: false };
  const gateCheck = typeof claimedGateCompanion === 'string' && claimedGateCompanion.trim() ? await ghFileExists(owner, repo, claimedGateCompanion, fetchImpl) : { exists: false };

  let crossReferenced = false;
  if (typeof claimedCrossRefFile === 'string' && claimedCrossRefFile.trim() && typeof claimedCrossRefPhrase === 'string' && claimedCrossRefPhrase.trim()) {
    const crossCheck = await ghFileExists(owner, repo, claimedCrossRefFile, fetchImpl);
    if (crossCheck.exists && crossCheck.json && crossCheck.json.content) {
      try { crossReferenced = b64ToText(crossCheck.json.content).includes(claimedCrossRefPhrase); } catch { crossReferenced = false; }
    }
  }

  const provenanceReal = !!fileCheck.exists;
  const gateBacked = !!gateCheck.exists;
  const passed = [provenanceReal, gateBacked, crossReferenced].filter(Boolean).length;
  return {
    ok: true, owner, repo, provenanceReal, gateBacked, crossReferenced,
    score: `${passed}/3`,
    decision: passed === 3 ? 'PASS' : 'FLAG',
    failedChecks: [!provenanceReal && 'provenance', !gateBacked && 'gate-companion', !crossReferenced && 'cross-reference'].filter(Boolean),
  };
}
