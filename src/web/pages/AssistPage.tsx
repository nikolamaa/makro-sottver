/**
 * Assist: paste a customer message, get the best macros, personalize, copy. The screen agents use all day,
 * so everything is keyboard-driven and memoized: typing in one box re-renders only that box.
 */
import { useMemo, useRef } from 'react';
import type { Category, Id, Macro } from '../../shared/types';
import { AnalysisPanel } from '../components/assist/AnalysisPanel';
import { MatchBanners } from '../components/assist/MatchBanners';
import { MessagePanel } from '../components/assist/MessagePanel';
import { RecommendationList } from '../components/assist/RecommendationList';
import { ReplyEditor } from '../components/assist/ReplyEditor';
import { ShortcutLegend, useAssistHotkeys } from '../components/assist/shortcuts';
import { useAssist } from '../components/assist/useAssist';
import { detectedVariables, variablesUsed } from '../components/assist/variables';
import { VariablesPanel } from '../components/assist/VariablesPanel';
import { useStore } from '../store';
import './assist.css';

export function AssistPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const { state, actions, analyzing, personalizing, messageRef, editorRef } = useAssist();
  const macros = useStore((s) => s.macros);
  const categories = useStore((s) => s.categories);
  const aiReady = useStore((s) => s.health?.ai.ready ?? false);
  const aiDetail = useStore((s) => s.health?.ai.detail ?? '');
  const userFallback = useStore((s) => s.settings?.personalization.userFallback ?? 'there');
  useAssistHotkeys(actions, { page: pageRef, message: messageRef }, state.result?.recommendations.length ?? 0);

  const macroById = useMemo(() => new Map<Id, Macro>(macros.map((m) => [m.id, m])), [macros]);
  const categoryById = useMemo(() => new Map<Id, Category>(categories.map((c) => [c.id, c])), [categories]);
  const result = state.result;
  const detected = useMemo(
    () => result?.detectedVariables ?? detectedVariables(result?.analysis.entities ?? []),
    [result],
  );
  const variableNames = useMemo(
    () => variablesUsed(state.selectedIds.flatMap((id) => macroById.get(id)?.body ?? [])),
    [state.selectedIds, macroById],
  );
  const primary = state.selectedIds[0] ? macroById.get(state.selectedIds[0]) : undefined;
  const namePlaceholder = detected.user ? `${detected.user} (detected)` : `${userFallback} (fallback)`;

  return (
    <div className="page assist" ref={pageRef}>
      <div className="assist-grid">
        <div className="assist-col">
          <MessagePanel
            message={state.message}
            customerName={state.customerName}
            namePlaceholder={namePlaceholder}
            messageRef={messageRef}
            actions={actions}
          />
          <VariablesPanel
            names={variableNames}
            detected={detected}
            overrides={state.overrides}
            hasSelection={state.selectedIds.length > 0}
            onChange={actions.setOverride}
          />
          <AnalysisPanel result={state.result} analyzing={analyzing} error={state.recError} />
        </div>
        <div className="assist-col">
          <MatchBanners result={state.result} selectedIds={state.selectedIds} aiReady={aiReady} drafting={state.busy.draft} actions={actions} />
          <RecommendationList
            result={state.result}
            analyzing={analyzing}
            hasMessage={state.message.trim() !== ''}
            selectedIds={state.selectedIds}
            macroById={macroById}
            categoryById={categoryById}
            actions={actions}
          />
          <ReplyEditor
            reply={state.reply}
            personalizing={personalizing}
            aiBusy={state.busy.ai}
            aiReady={aiReady}
            aiDetail={aiDetail}
            primary={primary}
            editorRef={editorRef}
            actions={actions}
          />
        </div>
      </div>
      <ShortcutLegend />
    </div>
  );
}
