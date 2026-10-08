import { memo, useMemo, type RefObject } from 'react';
import { findPlaceholders } from '../../../shared/template';
import type { GuardrailKind, Macro } from '../../../shared/types';
import { Badge, Button, Spinner } from '../../ui';
import type { ReplyMeta, ReplyState } from './assistState';
import { modeLabel } from './format';
import { useAutoHeight } from './hooks';
import { toggleFavorite } from './requests';
import { selectNextOccurrence } from './textSelection';
import type { AssistActions } from './useAssist';

interface ReplyEditorProps {
  reply: ReplyState;
  personalizing: boolean;
  aiBusy: boolean;
  aiReady: boolean;
  /** Why AI is unavailable (tooltip of the disabled AI button). */
  aiDetail: string;
  /** First selected macro (edit / favorite target). */
  primary: Macro | undefined;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  actions: AssistActions;
}

const GUARDRAIL_LABELS: Record<GuardrailKind, string> = {
  unsupported_number: 'Number not found in the sources',
  unsupported_url: 'Link not found in the sources',
  unsupported_claim: 'Claim not supported by the sources',
  promise: 'Promise or guarantee',
  placeholder_left: 'Placeholder left',
};

function ModeBadges({ meta, edited }: { meta: ReplyMeta | null; edited: boolean }) {
  if (!meta) return null;
  return (
    <span className="row">
      {meta.source === 'draft' ? <Badge tone="info">draft</Badge> : null}
      <Badge tone={meta.mode === 'ai' ? 'accent' : 'neutral'} title={meta.llm ? `${meta.llm.inputTokens} in / ${meta.llm.outputTokens} out tokens` : 'Deterministic, local, free'}>
        {modeLabel(meta.llm)}
      </Badge>
      {edited ? <span className="muted small">edited</span> : null}
    </span>
  );
}

function ReplyStatus({ reply, personalizing, aiBusy, actions }: Pick<ReplyEditorProps, 'reply' | 'personalizing' | 'aiBusy' | 'actions'>) {
  if (personalizing) {
    return (
      <span className="row muted small">
        <Spinner label="Personalizing" /> Personalizing…
      </span>
    );
  }
  if (aiBusy) {
    return (
      <span className="row muted small">
        <Spinner label="AI polishing" /> AI polishing…
      </span>
    );
  }
  if (reply.pendingAi) {
    return (
      <Button size="sm" variant="secondary" onClick={actions.applyPendingAi}>
        AI version ready - Replace
      </Button>
    );
  }
  return null;
}

function PlaceholderBar({ placeholders, editorRef }: { placeholders: string[]; editorRef: RefObject<HTMLTextAreaElement | null> }) {
  if (!placeholders.length) return null;
  return (
    <div className="reply-placeholders" role="group" aria-label="Placeholders to fill in">
      <span className="muted small">Fill in:</span>
      {placeholders.map((label) => (
        <button
          key={label}
          type="button"
          className="placeholder-mark reply-placeholder"
          onClick={() => editorRef.current && selectNextOccurrence(editorRef.current, label)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ReplyNotes({ meta }: { meta: ReplyMeta }) {
  const { guardrail, warnings, unansweredQuestions } = meta;
  if (!guardrail.length && !warnings.length && !unansweredQuestions.length) return null;
  return (
    <ul className="reply-notes">
      {guardrail.map((g, i) => (
        <li key={`g${i}`} className="reply-note reply-note-danger">
          <strong>{GUARDRAIL_LABELS[g.kind]}:</strong> <q>{g.text}</q> {g.detail}
        </li>
      ))}
      {unansweredQuestions.map((q, i) => (
        <li key={`q${i}`} className="reply-note reply-note-info">
          <strong>Not covered by the selected macro:</strong> <q>{q}</q>
        </li>
      ))}
      {warnings.map((w, i) => (
        <li key={`w${i}`} className="reply-note reply-note-warning">
          {w}
        </li>
      ))}
    </ul>
  );
}

/** Personalized reply editor with placeholder navigation, AI status, guardrail notes and actions. */
export const ReplyEditor = memo(function ReplyEditor(props: ReplyEditorProps) {
  const { reply, personalizing, aiBusy, aiReady, aiDetail, primary, editorRef, actions } = props;
  const placeholders = useMemo(() => findPlaceholders(reply.text), [reply.text]);
  useAutoHeight(editorRef, reply.text);
  const canPolish = aiReady && reply.request !== null && !aiBusy;

  return (
    <section className="panel assist-reply" aria-label="Reply">
      <div className="assist-section-head">
        <div className="row">
          <h2 className="assist-title">Reply</h2>
          <ModeBadges meta={reply.meta} edited={reply.text !== reply.generated} />
        </div>
        <ReplyStatus reply={reply} personalizing={personalizing} aiBusy={aiBusy} actions={actions} />
      </div>
      <PlaceholderBar placeholders={placeholders} editorRef={editorRef} />
      <textarea
        ref={editorRef}
        className="reply-text"
        aria-label="Reply text"
        value={reply.text}
        placeholder="The personalized reply appears here. Pick a macro with Alt+1..3."
        onChange={(e) => actions.edit(e.target.value)}
      />
      <div className="reply-actions">
        <Button variant="primary" hotkey="mod+enter" onClick={() => void actions.copy()} disabled={!reply.text.trim()}>
          Copy reply
        </Button>
        <span title={aiReady ? 'Rewrite the reply with AI (facts stay grounded in the macro)' : aiDetail || 'AI is off - enable it in Settings'}>
          <Button hotkey="mod+j" onClick={actions.polish} disabled={!canPolish}>
            AI polish
          </Button>
        </span>
        <span className="spacer" />
        <Button variant="ghost" onClick={actions.editMacro} disabled={!primary}>
          Edit macro
        </Button>
        {primary ? (
          <Button
            variant="ghost"
            aria-pressed={primary.isFavorite}
            onClick={() => void toggleFavorite(primary)}
            title={primary.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            {primary.isFavorite ? '★ Favorite' : '☆ Favorite'}
          </Button>
        ) : null}
      </div>
      {reply.meta ? <ReplyNotes meta={reply.meta} /> : null}
    </section>
  );
});
