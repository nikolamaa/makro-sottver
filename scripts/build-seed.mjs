#!/usr/bin/env node
/**
 * Build seed/stake-demo-macros.json (MacroPilot export format) and seed/eval-messages.json from the
 * Stake Help Center research output (extracted facts/macros + independent verification verdicts).
 *
 *   node scripts/build-seed.mjs <research.json>
 *
 * Only facts verified as correct (or fixed by the verifier) and macros marked ok/fixed are kept.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INTENTS = new Set([
  'deposit_missing', 'deposit_help', 'withdrawal_pending', 'withdrawal_help', 'withdrawal_limits', 'payment_methods',
  'bonus_inquiry', 'wagering_requirement', 'vip_program', 'kyc_verification', 'account_access', 'account_security',
  'account_closure', 'responsible_gambling', 'sports_betting', 'casino_games', 'betting_limits', 'technical_issue',
  'affiliate', 'complaint', 'general',
]);
const CATEGORY_COLORS = ['#4f7cff', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#0d9488', '#7c3aed', '#64748b', '#2563eb'];
const VERIFIED_AT = '2026-10-08';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/build-seed.mjs <research.json>');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const groups = JSON.parse(readFileSync(input, 'utf8'));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const categories = new Map();
const macros = [];
const evalMessages = [];
const stats = { factsKept: 0, factsFixed: 0, factsRejected: 0, macrosKept: 0, macrosFixed: 0, macrosRejected: 0, messages: 0 };

for (const g of groups) {
  const ex = g.extracted;
  const ver = g.verification;
  if (!ex || !ver) continue;

  const factVerdicts = new Map(ver.fact_verdicts.map((v) => [v.key, v]));
  const facts = new Map();
  for (const f of ex.facts) {
    const v = factVerdicts.get(f.key);
    if (!v || v.verdict === 'reject') {
      stats.factsRejected++;
      continue;
    }
    const final = v.verdict === 'fixed' && v.corrected_fact ? v.corrected_fact : f;
    if (v.verdict === 'fixed') stats.factsFixed++;
    stats.factsKept++;
    facts.set(f.key, final);
    if (final.key !== f.key) facts.set(final.key, final);
  }

  const macroVerdicts = new Map(ver.macro_verdicts.map((v) => [v.title, v]));
  const keptTitles = new Set();
  for (const m of ex.macros) {
    const v = macroVerdicts.get(m.title);
    if (!v || v.verdict === 'reject') {
      stats.macrosRejected++;
      continue;
    }
    const body = v.verdict === 'fixed' && v.corrected_body ? v.corrected_body : m.body;
    const factKeys = v.verdict === 'fixed' && v.corrected_fact_keys?.length ? v.corrected_fact_keys : m.fact_keys;
    if (v.verdict === 'fixed') stats.macrosFixed++;
    stats.macrosKept++;
    keptTitles.add(m.title);

    if (!categories.has(m.category)) {
      categories.set(m.category, { id: `cat-${slug(m.category)}`, name: m.category, color: CATEGORY_COLORS[categories.size % CATEGORY_COLORS.length] });
    }
    const usedFacts = [...new Set(factKeys)].map((k) => facts.get(k)).filter(Boolean);
    const sources = [...new Set(usedFacts.map((f) => f.source_url))];
    macros.push({
      id: `seed-${slug(m.title)}`,
      title: m.title,
      body: body.trim(),
      categoryId: categories.get(m.category).id,
      category: m.category,
      tags: m.tags,
      intents: m.intents.filter((i) => INTENTS.has(i)),
      triggers: m.trigger_examples,
      notes: `Demo macro built from the public Stake Help Center (facts verified ${VERIFIED_AT}). Review before use.${sources.length ? `\nSources:\n${sources.join('\n')}` : ''}`,
      shortcut: '',
      isFavorite: false,
      archived: false,
      facts: usedFacts.map((f) => ({
        key: f.key,
        statement: f.statement,
        value: f.value,
        sourceUrl: f.source_url,
        evidenceQuote: f.evidence_quote,
        status: 'verified',
      })),
    });
  }

  for (const t of ex.test_messages) {
    if (t.expected_macro_title !== 'NONE' && !keptTitles.has(t.expected_macro_title)) continue;
    evalMessages.push({ message: t.message, expected: t.expected_macro_title, intent: t.intent, sentiment: t.sentiment });
    stats.messages++;
  }
}

// Off-topic messages: the recommender must answer "no good match" for these.
for (const message of [
  "what's the weather going to be like in Belgrade tomorrow?",
  'Can you recommend a good pizza place near me?',
  'Who won the Eurovision song contest in 2019?',
  'hello? is anyone there',
  'Do you guys sponsor any local chess clubs?',
]) {
  evalMessages.push({ message, expected: 'NONE', intent: 'general', sentiment: 'neutral' });
  stats.messages++;
}

macros.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
const exportDoc = {
  format: 'macropilot-macros',
  version: 1,
  exportedAt: `${VERIFIED_AT}T00:00:00.000Z`,
  categories: [...categories.values()],
  macros,
};
writeFileSync(`${root}seed/stake-demo-macros.json`, `${JSON.stringify(exportDoc, null, 2)}\n`);
writeFileSync(`${root}seed/eval-messages.json`, `${JSON.stringify(evalMessages, null, 2)}\n`);
console.log(JSON.stringify(stats));
