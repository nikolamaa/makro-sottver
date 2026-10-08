import { memo } from 'react';
import type { Analysis, Entity, RecommendResponse } from '../../../shared/types';
import { INTENT_LABELS } from '../../../shared/types';
import { Badge, copyToClipboard, toast } from '../../ui';
import { percent, plural, sentimentTone, timingLabel, urgencyTone } from './format';

interface AnalysisPanelProps {
  result: RecommendResponse | null;
  analyzing: boolean;
  error: string | null;
}

const ENTITY_LABEL_SEPARATORS = /_/g;

function uniqueEntities(entities: readonly Entity[]): Entity[] {
  const seen = new Set<string>();
  return entities.filter((e) => {
    const key = `${e.type}\u0000${e.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function copyEntity(entity: Entity): Promise<void> {
  const label = entity.type.replace(ENTITY_LABEL_SEPARATORS, ' ');
  if (await copyToClipboard(entity.value)) toast(`Copied ${label}`, 'success', 1200);
  else toast('Copy failed', 'danger');
}

function RiskBanners({ analysis }: { analysis: Analysis }) {
  return (
    <>
      {analysis.rgRisk ? (
        <div className="assist-banner assist-banner-danger" role="alert">
          <strong>Responsible gambling risk - follow the RG procedure</strong>
          {analysis.rgSignals.length ? <span className="small">Signals: {analysis.rgSignals.join(', ')}</span> : null}
        </div>
      ) : null}
      {analysis.isLikelyNonEnglish ? (
        <div className="assist-banner assist-banner-warning" role="status">
          This message may not be in English - paste the Intercom translation for the best matches.
        </div>
      ) : null}
    </>
  );
}

function AnalysisDetails({ result }: { result: RecommendResponse }) {
  const a = result.analysis;
  const entities = uniqueEntities(a.entities);
  return (
    <>
      <RiskBanners analysis={a} />
      <div className="row-wrap" aria-label="Detected intents">
        {a.intents.map((i) => (
          <span key={i.intent} className="assist-chip assist-chip-intent">
            {INTENT_LABELS[i.intent]} <b>{percent(i.score)}</b>
          </span>
        ))}
        <Badge tone={sentimentTone(a.sentiment)}>{a.sentiment}</Badge>
        <Badge tone={urgencyTone(a.urgency)} title={a.urgencyReasons.join(', ') || undefined}>
          {a.urgency} urgency
        </Badge>
        {a.questions.length > 1 ? <Badge tone="info">{plural(a.questions.length, 'question')}</Badge> : null}
      </div>
      {entities.length ? (
        <div className="row-wrap" aria-label="Detected details (click to copy)">
          {entities.map((e) => (
            <button
              key={`${e.type}:${e.value}`}
              type="button"
              className="assist-chip assist-chip-entity"
              title="Click to copy"
              onClick={() => void copyEntity(e)}
            >
              <span className="muted">{e.type.replace(ENTITY_LABEL_SEPARATORS, ' ')}</span> {e.value}
            </button>
          ))}
        </div>
      ) : null}
      <p className="assist-timing">{timingLabel(result)}</p>
    </>
  );
}

function AnalysisSkeleton() {
  return (
    <div className="stack" aria-hidden>
      <div className="row-wrap">
        <span className="skeleton skeleton-chip" />
        <span className="skeleton skeleton-chip" />
        <span className="skeleton skeleton-chip short" />
      </div>
      <span className="skeleton skeleton-line short" />
    </div>
  );
}

/** Intents, sentiment, urgency, entities and risk warnings for the current message. */
export const AnalysisPanel = memo(function AnalysisPanel({ result, analyzing, error }: AnalysisPanelProps) {
  if (!result && !analyzing && !error) return null;
  return (
    <section className={`panel assist-analysis ${analyzing ? 'is-stale' : ''}`} aria-label="Message analysis" aria-busy={analyzing}>
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
      {result ? <AnalysisDetails result={result} /> : analyzing ? <AnalysisSkeleton /> : null}
    </section>
  );
});
