/**
 * AssistService: message -> analysis -> recommendations -> personalized reply.
 * The local path (analysis + hybrid search + deterministic personalization) never needs the network.
 */
import { performance } from 'node:perf_hooks';
import type {
  AppSettings,
  DraftRequest,
  DraftResponse,
  Fact,
  Intent,
  PersonalizeRequest,
  PersonalizeResponse,
  RecommendResponse,
} from '../../shared/types.js';
import { INTENT_LABELS } from '../../shared/types.js';
import { findPlaceholders, renderTemplate } from '../../shared/template.js';
import { analyzeMessage } from '../analysis/analyzer.js';
import type { AiService } from '../ai/aiService.js';
import { applyTone, ensureGreeting, personalizeFast, variablesFromAnalysis } from '../personalize/personalize.js';
import type { MacroIndex } from '../search/macroIndex.js';
import type { LibraryService } from './library.js';

export const MAX_MESSAGE_CHARS = 8000;

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export class AssistService {
  constructor(
    private readonly library: LibraryService,
    private readonly index: MacroIndex,
    private readonly ai: AiService,
    private readonly settings: () => AppSettings,
  ) {}

  private checkMessage(message: string): string {
    if (typeof message !== 'string') throw new BadRequestError('message must be a string');
    if (message.length > MAX_MESSAGE_CHARS) throw new BadRequestError(`Message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
    return message;
  }

  async recommend(message: string): Promise<RecommendResponse> {
    const text = this.checkMessage(message);
    const t0 = performance.now();
    const analysis = analyzeMessage(text);
    const t1 = performance.now();
    const s = this.settings().recommendation;
    const result = text.trim()
      ? await this.index.search(text, analysis, { maxResults: s.maxResults, minConfidence: s.minConfidence })
      : { recommendations: [], noGoodMatch: false, uncoveredIntents: [] as Intent[] };
    const t2 = performance.now();
    return {
      analysis,
      recommendations: result.recommendations,
      noGoodMatch: result.noGoodMatch,
      uncoveredIntents: result.uncoveredIntents,
      detectedVariables: variablesFromAnalysis(analysis),
      embeddings: this.index.embedder.status(),
      timingMs: { analysis: round(t1 - t0), search: round(t2 - t1), total: round(t2 - t0) },
    };
  }

  async personalize(req: PersonalizeRequest): Promise<PersonalizeResponse> {
    const message = this.checkMessage(req.message ?? '');
    if (!Array.isArray(req.macroIds) || req.macroIds.length < 1 || req.macroIds.length > 3) {
      throw new BadRequestError('Select between 1 and 3 macros');
    }
    const macros = this.library.getActive(req.macroIds);
    const analysis = analyzeMessage(message);
    const overrides = cleanVariables(req.variables);
    if (req.mode === 'ai') {
      const variables = { ...variablesFromAnalysis(analysis), ...overrides };
      return this.ai.personalize({ message, analysis, macros, variables });
    }
    return personalizeFast({ message, macros, analysis, variables: overrides, settings: this.settings().personalization });
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const message = this.checkMessage(req.message ?? '');
    const analysis = analyzeMessage(message);
    const overrides = cleanVariables(req.variables);
    const variables = { ...variablesFromAnalysis(analysis), ...overrides };
    if (this.ai.isReady()) {
      const s = this.settings().recommendation;
      const near = await this.index.search(message, analysis, { maxResults: 3, minConfidence: s.minConfidence });
      const facts: Fact[] = near.recommendations
        .flatMap((r) => this.library.get(r.macroId).facts)
        .filter((f) => f.status === 'verified');
      return this.ai.draft({ message, analysis, variables, facts });
    }
    return localDraft(message, analysis, variables, this.settings().personalization);
  }
}

/** Offline draft: greeting + tone + one placeholder line per question, so the agent only fills in answers. */
function localDraft(
  message: string,
  analysis: ReturnType<typeof analyzeMessage>,
  variables: Record<string, string>,
  p: AppSettings['personalization'],
): DraftResponse {
  const topics = analysis.questions.length
    ? analysis.questions.map((q) => (q.intent ? INTENT_LABELS[q.intent] : q.text.slice(0, 40)))
    : [analysis.intents[0] ? INTENT_LABELS[analysis.intents[0].intent] : 'the request'];
  const lines = [...new Set(topics)].map((t) => `[ENTER ANSWER ABOUT ${t.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()}]`);
  let text = ensureGreeting(lines.join('\n\n'), p.greeting, variables, p.userFallback);
  if (p.toneAdjust) text = applyTone(text, analysis, true).text;
  const rendered = renderTemplate(text, variables).text;
  const title = analysis.questions[0]?.text ?? message.split(/[.?!\n]/)[0] ?? 'New macro';
  return {
    text: rendered,
    suggestedTitle: title.trim().slice(0, 80) || 'New macro',
    suggestedIntents: analysis.intents.slice(0, 2).map((i) => i.intent),
    placeholders: findPlaceholders(rendered).map((label) => ({ label, variable: null })),
    guardrail: [],
    warnings: ['AI is off: this is an empty reply skeleton. Fill in the placeholders or enable AI in Settings.'],
    llm: null,
  };
}

function cleanVariables(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== 'object') return out;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string') continue;
    const key = k.trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(key)) continue;
    const value = v.trim().slice(0, 300);
    if (value) out[key] = value;
  }
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
