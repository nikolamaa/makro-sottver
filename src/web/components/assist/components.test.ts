import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Category, Macro } from '../../../shared/types';
import { AnalysisPanel } from './AnalysisPanel';
import { EMPTY_REPLY, type ReplyState } from './assistState';
import { MatchBanners } from './MatchBanners';
import { RecommendationList } from './RecommendationList';
import { ReplyEditor } from './ReplyEditor';
import { analysisFixture, personalizeFixture, recommendationFixture, resultFixture } from './testFixtures';
import type { AssistActions } from './useAssist';
import { VariablesPanel } from './VariablesPanel';

const actions = {} as AssistActions;

function html<P extends object>(component: FunctionComponent<P>, props: P): string {
  return renderToStaticMarkup(createElement(component, props));
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

describe('AnalysisPanel', () => {
  it('shows intents, sentiment, urgency, entities and timing', () => {
    const out = text(html(AnalysisPanel, { result: resultFixture(), analyzing: false, error: null }));
    expect(out).toContain('Pending withdrawal 82%');
    expect(out).toContain('frustrated');
    expect(out).toContain('high urgency');
    expect(out).toContain('name Marko');
    expect(out).toContain('analysis 2 ms · search 9 ms · builtin');
    expect(out).not.toContain('Responsible gambling');
  });

  it('raises the RG banner and the non-English warning', () => {
    const result = resultFixture({ analysis: analysisFixture({ rgRisk: true, rgSignals: ['lost everything'], isLikelyNonEnglish: true }) });
    const markup = html(AnalysisPanel, { result, analyzing: false, error: null });
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain('Responsible gambling risk - follow the RG procedure');
    expect(text(markup)).toContain('Signals: lost everything');
    expect(text(markup)).toContain('may not be in English');
  });

  it('renders a skeleton while the first analysis runs and nothing when idle', () => {
    expect(html(AnalysisPanel, { result: null, analyzing: true, error: null })).toContain('skeleton');
    expect(html(AnalysisPanel, { result: null, analyzing: false, error: null })).toBe('');
    expect(text(html(AnalysisPanel, { result: null, analyzing: false, error: 'Message is too long' }))).toContain('Message is too long');
  });
});

describe('RecommendationList', () => {
  const categories = new Map<string, Category>([['c1', { id: 'c1', name: 'Payments', color: '#123456', sort: 0 }]]);
  const favorite = { id: 'a', isFavorite: true } as Macro;
  const picked = { id: 'p', title: 'Picked macro', isFavorite: false, verification: 'verified', categoryId: null } as Macro;
  const macros = new Map<string, Macro>([
    ['a', favorite],
    ['p', picked],
  ]);
  const result = resultFixture({
    recommendations: [
      recommendationFixture('a', { categoryId: 'c1' }),
      recommendationFixture('b', { verification: 'unverified' }),
      recommendationFixture('c', { verification: 'conflict', warnings: ['1 fact(s) contradict the source: min 20 USD'] }),
    ],
  });
  const base = { result, analyzing: false, hasMessage: true, selectedIds: ['a'], macroById: macros, categoryById: categories, actions };

  it('renders cards with confidence, verification, category, reason and matched terms', () => {
    const markup = html(RecommendationList, base);
    const out = text(markup);
    expect(out).toContain('Macro a');
    expect(out).toContain('82%');
    expect(out).toContain('verified');
    expect(out).toContain('not verified');
    expect(out).toContain('conflict');
    expect(out).toContain('1 fact(s) contradict the source: min 20 USD');
    expect(out).toContain('Payments');
    expect(out).toContain('Matches the pending withdrawal question.');
    expect(out).toContain('matched: withdrawal, pending');
    expect(markup.match(/aria-pressed="true"/g)?.length).toBe(2); // selected card + favorite star
    expect(markup).toContain('Remove from favorites');
  });

  it('marks combined parts and shows macros picked from search', () => {
    const out = text(html(RecommendationList, { ...base, selectedIds: ['p', 'a'] }));
    expect(out).toContain('from search');
    expect(out).toContain('Picked macro');
    expect(out).toContain('part 2');
  });

  it('shows skeletons, the empty state and stale results', () => {
    expect(html(RecommendationList, { ...base, result: null, analyzing: true })).toContain('rec-skeleton');
    expect(text(html(RecommendationList, { ...base, result: null, hasMessage: false, selectedIds: [] }))).toContain('Paste a customer message');
    expect(html(RecommendationList, { ...base, analyzing: true })).toContain('is-stale');
  });
});

describe('MatchBanners', () => {
  const noMatch = resultFixture({ noGoodMatch: true, recommendations: [recommendationFixture('a', { confidence: 31.6 })] });

  it('offers drafting and creating a macro when nothing matches well', () => {
    const off = text(html(MatchBanners, { result: noMatch, selectedIds: [], aiReady: false, drafting: false, actions }));
    expect(off).toContain('No macro matches well (best 32%)');
    expect(off).toContain('Draft reply');
    expect(off).toContain('Create new macro');
    expect(text(html(MatchBanners, { result: noMatch, selectedIds: [], aiReady: true, drafting: false, actions }))).toContain('Draft with AI');
  });

  it('suggests combining a macro for uncovered questions', () => {
    const result = resultFixture({
      uncoveredIntents: ['kyc_verification'],
      recommendations: [recommendationFixture('a'), recommendationFixture('b', { coversIntents: ['kyc_verification'] })],
    });
    const out = text(html(MatchBanners, { result, selectedIds: ['a'], aiReady: false, drafting: false, actions }));
    expect(out).toContain('Customer also asks about: Verification (KYC) - add a second macro (Alt Shift 2) to combine');
    expect(out).toContain('Combine #2');
    expect(html(MatchBanners, { result, selectedIds: ['a', 'b'], aiReady: false, drafting: false, actions })).toBe('');
  });
});

describe('ReplyEditor', () => {
  const editorRef = { current: null };
  const base = { personalizing: false, aiBusy: false, aiReady: false, aiDetail: 'AI is off', primary: undefined, editorRef, actions };

  function reply(partial: Partial<ReplyState>): ReplyState {
    return { ...EMPTY_REPLY, ...partial };
  }

  it('lists remaining placeholders and the fast mode badge', () => {
    const res = personalizeFixture('Hi [ENTER USER], ETA [ENTER ETA TIME].');
    const out = text(html(ReplyEditor, { ...base, reply: reply({ text: res.text, generated: res.text, meta: { source: 'macro', mode: 'fast', llm: null, guardrail: [], warnings: ['1 fact(s) outdated'], unansweredQuestions: [] } }) }));
    expect(out).toContain('Fill in: [ENTER USER] [ENTER ETA TIME]');
    expect(out).toContain('fast');
    expect(out).toContain('1 fact(s) outdated');
  });

  it('disables AI polish with an explanation when AI is not ready', () => {
    const markup = html(ReplyEditor, { ...base, reply: reply({ text: 'x', generated: 'x' }) });
    expect(markup).toMatch(/title="AI is off"><button[^>]*disabled/);
  });

  it('shows the AI badge with cost, guardrail issues and the pending AI version', () => {
    const llm = { provider: 'anthropic' as const, model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 120, costUsd: 0.0003, latencyMs: 800 };
    const meta = {
      source: 'macro' as const,
      mode: 'ai' as const,
      llm,
      guardrail: [{ kind: 'unsupported_number' as const, text: '48 hours', detail: 'Not in the macro or facts.' }],
      warnings: [],
      unansweredQuestions: ['Can I get a bonus?'],
    };
    const out = text(
      html(ReplyEditor, {
        ...base,
        aiReady: true,
        reply: reply({ text: 'edited', generated: 'gen', meta, pendingAi: personalizeFixture('ai', { mode: 'ai' }) }),
      }),
    );
    expect(out).toContain('AI · claude-haiku-5-5 · $0.0003');
    expect(out).toContain('edited');
    expect(out).toContain('AI version ready - Replace');
    expect(out).toContain('Number not found in the sources: 48 hours Not in the macro or facts.');
    expect(out).toContain('Not covered by the selected macro: Can I get a bonus?');
  });

  it('shows progress while personalizing', () => {
    expect(text(html(ReplyEditor, { ...base, personalizing: true, reply: EMPTY_REPLY }))).toContain('Personalizing');
    expect(text(html(ReplyEditor, { ...base, aiBusy: true, reply: EMPTY_REPLY }))).toContain('AI polishing');
  });
});

describe('VariablesPanel', () => {
  it('shows detected values and placeholders as input hints', () => {
    const markup = html(VariablesPanel, {
      names: ['amount', 'eta_time'],
      detected: { amount: '250' },
      overrides: { eta_time: '' },
      hasSelection: true,
      onChange: () => undefined,
    });
    expect(markup).toContain('placeholder="250"');
    expect(markup).toContain('placeholder="[ENTER ETA TIME]"');
    expect(text(markup)).toContain('1/2 set');
  });

  it('explains an empty list', () => {
    const props = { names: [], detected: {}, overrides: {}, onChange: () => undefined };
    expect(text(html(VariablesPanel, { ...props, hasSelection: false }))).toContain('Select a macro to see its variables.');
    expect(text(html(VariablesPanel, { ...props, hasSelection: true }))).toContain('The selected macro has no variables.');
  });
});
