import { memo, useMemo, type MouseEvent } from 'react';
import type { Category, Id, Macro, Recommendation, RecommendResponse, VerificationStatus } from '../../../shared/types';
import { Badge, ConfidenceBar, EmptyState, Kbd, Spinner } from '../../ui';
import { verificationBadge } from './format';
import { IDLE_RERANK, shownRecommendations, type RerankState } from './rerank';
import { toggleFavorite } from './requests';
import type { AssistActions } from './useAssist';

interface RecommendationListProps {
  result: RecommendResponse | null;
  analyzing: boolean;
  hasMessage: boolean;
  selectedIds: Id[];
  macroById: ReadonlyMap<Id, Macro>;
  categoryById: ReadonlyMap<Id, Category>;
  actions: AssistActions;
  /** AI double-check of `result` (idle when the AI is off). */
  rerank?: RerankState;
}

const AI_PICK_TITLE = 'The AI double-check rates this macro the best fit';

const SKELETON_CARDS = [0, 1, 2];

function CategoryTag({ category }: { category: Category | undefined }) {
  if (!category) return null;
  return (
    <span className="rec-category">
      <i style={{ background: category.color }} aria-hidden />
      {category.name}
    </span>
  );
}

function FavoriteStar({ id, favorite }: { id: Id; favorite: boolean }) {
  return (
    <button
      type="button"
      className={`rec-star ${favorite ? 'is-on' : ''}`}
      aria-pressed={favorite}
      aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
      title={favorite ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => void toggleFavorite({ id, isFavorite: favorite })}
    >
      {favorite ? '★' : '☆'}
    </button>
  );
}

function VerificationBadge({ status }: { status: VerificationStatus }) {
  const badge = verificationBadge(status);
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

interface CardProps {
  /** Recommendation as displayed (AI confidence/reason applied when aiScored). */
  rec: Recommendation;
  rank: number;
  /** Position in the selection (0 = primary), -1 when not selected. */
  order: number;
  combined: boolean;
  favorite: boolean;
  category: Category | undefined;
  actions: AssistActions;
  aiScored: boolean;
  aiLower: boolean;
  aiPick: boolean;
  localConfidence: number;
}

function confidenceTitle(confidence: number, localConfidence: number, aiScored: boolean, aiLower: boolean): string | undefined {
  const local = Math.round(localConfidence);
  if (aiScored) return `${Math.round(confidence)}% after the AI double-check (local match ${local}%)`;
  if (aiLower) return `The AI double-check ranks other macros higher (local match ${local}%)`;
  return undefined;
}

const RecommendationCard = memo(function RecommendationCard(props: CardProps) {
  const { rec, rank, order, combined, favorite, category, actions, aiScored, aiLower, aiPick, localConfidence } = props;
  const selected = order >= 0;
  const onClick = (e: MouseEvent) => (e.shiftKey ? actions.toggleCombine(rank) : actions.select(rank));
  return (
    <li className={`rec-card ${selected ? 'is-selected' : ''}`}>
      <button type="button" className="rec-main" aria-pressed={selected} onClick={onClick} title="Click to use · Shift+click to combine">
        <span className="rec-head">
          <Kbd combo={`alt+${rank + 1}`} />
          <span className="rec-title">{rec.title}</span>
          {aiPick ? (
            <Badge tone="info" title={AI_PICK_TITLE}>
              AI pick
            </Badge>
          ) : null}
          {selected && combined ? <Badge tone="accent">part {order + 1}</Badge> : null}
        </span>
        <span className="rec-meta">
          <ConfidenceBar value={rec.confidence} title={confidenceTitle(rec.confidence, localConfidence, aiScored, aiLower)} />
          <VerificationBadge status={rec.verification} />
          <CategoryTag category={category} />
        </span>
        <span className="rec-reason">
          {aiScored ? (
            <span className="rec-ai-mark" title="Reason from the AI double-check">
              AI
            </span>
          ) : null}
          {rec.reason}
        </span>
        {rec.warnings.length ? <span className={`rec-warnings rec-warnings-${rec.verification}`}>{rec.warnings.join(' · ')}</span> : null}
        {rec.matchedTerms.length ? <span className="rec-terms">matched: {rec.matchedTerms.join(', ')}</span> : null}
      </button>
      <FavoriteStar id={rec.macroId} favorite={favorite} />
    </li>
  );
});

/** A macro chosen from quick search (or the AI suggestion) that is not among the recommendations. */
const PickedCard = memo(function PickedCard({ macro, category, aiPick }: { macro: Macro; category: Category | undefined; aiPick: boolean }) {
  return (
    <li className="rec-card is-selected rec-picked">
      <div className="rec-main">
        <span className="rec-head">
          {aiPick ? (
            <Badge tone="info" title={AI_PICK_TITLE}>
              AI pick
            </Badge>
          ) : (
            <Badge tone="info">from search</Badge>
          )}
          <span className="rec-title">{macro.title}</span>
        </span>
        <span className="rec-meta">
          <VerificationBadge status={macro.verification} />
          <CategoryTag category={category} />
        </span>
      </div>
      <FavoriteStar id={macro.id} favorite={macro.isFavorite} />
    </li>
  );
});

function SkeletonCards() {
  return (
    <ul className="rec-list" aria-hidden>
      {SKELETON_CARDS.map((i) => (
        <li key={i} className="rec-card rec-skeleton">
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line short" />
          <span className="skeleton skeleton-line" />
        </li>
      ))}
    </ul>
  );
}

function EmptyRecommendations({ hasMessage, result }: { hasMessage: boolean; result: RecommendResponse | null }) {
  if (!hasMessage) {
    return (
      <EmptyState title="Paste a customer message">
        The best macros appear here instantly. Copy the reply with <Kbd combo="mod+enter" />.
      </EmptyState>
    );
  }
  // With noGoodMatch the banner above already offers drafting / creating a macro.
  if (result && !result.noGoodMatch) return <EmptyState title="No recommendations">Add or import macros to get suggestions.</EmptyState>;
  return null;
}

/** "AI suggests: <title>" for the AI's top pick that is not among the cards; Alt+4 or a click uses it. */
function AiSuggestion({ suggestion, actions }: { suggestion: Recommendation; actions: AssistActions }) {
  return (
    <button type="button" className="rec-ai-suggest" onClick={actions.pickAiSuggestion} title={suggestion.reason || undefined}>
      AI suggests: <strong>{suggestion.title}</strong>{' '}
      <span className="muted">
        (press <Kbd combo="alt+4" /> or click to use)
      </span>
    </button>
  );
}

/** Recommendation cards (1..3) plus any macro picked from quick search, with the optional AI double-check. */
export const RecommendationList = memo(function RecommendationList(props: RecommendationListProps) {
  const { result, analyzing, hasMessage, selectedIds, macroById, categoryById, actions, rerank = IDLE_RERANK } = props;
  const recs = result?.recommendations;
  const shown = useMemo(() => shownRecommendations(recs ?? [], rerank), [recs, rerank]);
  const picked = selectedIds.filter((id) => !shown.some((s) => s.rec.macroId === id)).flatMap((id) => macroById.get(id) ?? []);
  const combined = selectedIds.length > 1;
  const showCards = shown.length > 0 || picked.length > 0;
  const suggestion = rerank.suggestion && !selectedIds.includes(rerank.suggestion.macroId) ? rerank.suggestion : null;

  return (
    <section className="assist-recs" aria-label="Recommendations" aria-busy={analyzing}>
      <div className="assist-section-head">
        <div className="assist-head-main">
          <h2 className="assist-title">Recommendations</h2>
          {rerank.status === 'running' ? (
            <span className="rec-ai-checking" role="status">
              <span className="spinner" aria-hidden="true" />
              AI checking…
            </span>
          ) : null}
        </div>
        {analyzing ? <Spinner label="Finding macros" /> : null}
      </div>
      {rerank.noGoodMatch ? (
        <p className="rec-ai-hint" role="status">
          AI: no macro fully answers this
        </p>
      ) : null}
      {!result && analyzing ? (
        <SkeletonCards />
      ) : showCards ? (
        <ul className={`rec-list ${analyzing ? 'is-stale' : ''}`} aria-label="Recommended macros">
          {picked.map((m) => (
            <PickedCard
              key={m.id}
              macro={m}
              category={m.categoryId ? categoryById.get(m.categoryId) : undefined}
              aiPick={m.id === rerank.topId}
            />
          ))}
          {shown.map(({ rec, aiScored, aiLower, aiPick, localConfidence }, rank) => (
            <RecommendationCard
              key={rec.macroId}
              rec={rec}
              rank={rank}
              order={selectedIds.indexOf(rec.macroId)}
              combined={combined}
              favorite={macroById.get(rec.macroId)?.isFavorite ?? false}
              category={rec.categoryId ? categoryById.get(rec.categoryId) : undefined}
              actions={actions}
              aiScored={aiScored}
              aiLower={aiLower}
              aiPick={aiPick}
              localConfidence={localConfidence}
            />
          ))}
        </ul>
      ) : (
        <EmptyRecommendations hasMessage={hasMessage} result={result} />
      )}
      {suggestion && result ? <AiSuggestion suggestion={suggestion} actions={actions} /> : null}
    </section>
  );
});
