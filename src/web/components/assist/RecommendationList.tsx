import { memo, type MouseEvent } from 'react';
import type { Category, Id, Macro, Recommendation, RecommendResponse, VerificationStatus } from '../../../shared/types';
import { Badge, ConfidenceBar, EmptyState, Kbd, Spinner } from '../../ui';
import { verificationBadge } from './format';
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
}

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
  rec: Recommendation;
  rank: number;
  /** Position in the selection (0 = primary), -1 when not selected. */
  order: number;
  combined: boolean;
  favorite: boolean;
  category: Category | undefined;
  actions: AssistActions;
}

const RecommendationCard = memo(function RecommendationCard({ rec, rank, order, combined, favorite, category, actions }: CardProps) {
  const selected = order >= 0;
  const onClick = (e: MouseEvent) => (e.shiftKey ? actions.toggleCombine(rank) : actions.select(rank));
  return (
    <li className={`rec-card ${selected ? 'is-selected' : ''}`}>
      <button type="button" className="rec-main" aria-pressed={selected} onClick={onClick} title="Click to use · Shift+click to combine">
        <span className="rec-head">
          <Kbd combo={`alt+${rank + 1}`} />
          <span className="rec-title">{rec.title}</span>
          {selected && combined ? <Badge tone="accent">part {order + 1}</Badge> : null}
        </span>
        <span className="rec-meta">
          <ConfidenceBar value={rec.confidence} />
          <VerificationBadge status={rec.verification} />
          <CategoryTag category={category} />
        </span>
        <span className="rec-reason">{rec.reason}</span>
        {rec.warnings.length ? <span className={`rec-warnings rec-warnings-${rec.verification}`}>{rec.warnings.join(' · ')}</span> : null}
        {rec.matchedTerms.length ? <span className="rec-terms">matched: {rec.matchedTerms.join(', ')}</span> : null}
      </button>
      <FavoriteStar id={rec.macroId} favorite={favorite} />
    </li>
  );
});

/** A macro chosen from quick search that is not among the recommendations. */
const PickedCard = memo(function PickedCard({ macro, category }: { macro: Macro; category: Category | undefined }) {
  return (
    <li className="rec-card is-selected rec-picked">
      <div className="rec-main">
        <span className="rec-head">
          <Badge tone="info">from search</Badge>
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

/** Recommendation cards (1..3) plus any macro picked from quick search. */
export const RecommendationList = memo(function RecommendationList(props: RecommendationListProps) {
  const { result, analyzing, hasMessage, selectedIds, macroById, categoryById, actions } = props;
  const recs = result?.recommendations ?? [];
  const picked = selectedIds.filter((id) => !recs.some((r) => r.macroId === id)).flatMap((id) => macroById.get(id) ?? []);
  const combined = selectedIds.length > 1;
  const showCards = recs.length > 0 || picked.length > 0;

  return (
    <section className="assist-recs" aria-label="Recommendations" aria-busy={analyzing}>
      <div className="assist-section-head">
        <h2 className="assist-title">Recommendations</h2>
        {analyzing ? <Spinner label="Finding macros" /> : null}
      </div>
      {!result && analyzing ? (
        <SkeletonCards />
      ) : showCards ? (
        <ul className={`rec-list ${analyzing ? 'is-stale' : ''}`} aria-label="Recommended macros">
          {picked.map((m) => (
            <PickedCard key={m.id} macro={m} category={m.categoryId ? categoryById.get(m.categoryId) : undefined} />
          ))}
          {recs.map((rec, rank) => (
            <RecommendationCard
              key={rec.macroId}
              rec={rec}
              rank={rank}
              order={selectedIds.indexOf(rec.macroId)}
              combined={combined}
              favorite={macroById.get(rec.macroId)?.isFavorite ?? false}
              category={rec.categoryId ? categoryById.get(rec.categoryId) : undefined}
              actions={actions}
            />
          ))}
        </ul>
      ) : (
        <EmptyRecommendations hasMessage={hasMessage} result={result} />
      )}
    </section>
  );
});
