import { memo } from 'react';
import type { Id, RecommendResponse } from '../../../shared/types';
import { INTENT_LABELS } from '../../../shared/types';
import { comboLabel } from '../../hotkeys';
import { Button, Spinner } from '../../ui';
import { uncoveredHint } from './selection';
import type { AssistActions } from './useAssist';

interface MatchBannersProps {
  result: RecommendResponse | null;
  selectedIds: Id[];
  aiReady: boolean;
  drafting: boolean;
  actions: AssistActions;
}

function NoMatchBanner({ result, aiReady, drafting, actions }: Omit<MatchBannersProps, 'selectedIds'> & { result: RecommendResponse }) {
  const best = Math.round(result.recommendations[0]?.confidence ?? 0);
  return (
    <div className="assist-banner assist-banner-warning" role="status">
      <strong>No macro matches well (best {best}%)</strong>
      <div className="row-wrap">
        <Button size="sm" variant="primary" onClick={() => void actions.draft()} disabled={drafting}>
          {drafting ? <Spinner label="Drafting" /> : null}
          {aiReady ? 'Draft with AI' : 'Draft reply'}
        </Button>
        <Button size="sm" onClick={actions.createMacro}>
          Create new macro
        </Button>
      </div>
    </div>
  );
}

function UncoveredBanner({ result, selectedIds, actions }: Pick<MatchBannersProps, 'selectedIds' | 'actions'> & { result: RecommendResponse }) {
  const { intents, coverRank } = uncoveredHint(result, selectedIds);
  if (!intents.length || !selectedIds.length) return null;
  const rank = coverRank >= 0 ? coverRank : 1;
  return (
    <div className="assist-banner assist-banner-info" role="status">
      <span>
        Customer also asks about: <strong>{intents.map((i) => INTENT_LABELS[i]).join(', ')}</strong> - add a second macro (
        {comboLabel(`alt+shift+${rank + 1}`)}) to combine
      </span>
      {coverRank >= 0 ? (
        <Button size="sm" onClick={() => actions.toggleCombine(coverRank)}>
          Combine #{coverRank + 1}
        </Button>
      ) : null}
    </div>
  );
}

/** "No good match" and "customer also asks about" banners above the recommendation cards. */
export const MatchBanners = memo(function MatchBanners({ result, selectedIds, aiReady, drafting, actions }: MatchBannersProps) {
  if (!result) return null;
  return (
    <>
      {result.noGoodMatch ? <NoMatchBanner result={result} aiReady={aiReady} drafting={drafting} actions={actions} /> : null}
      <UncoveredBanner result={result} selectedIds={selectedIds} actions={actions} />
    </>
  );
});
