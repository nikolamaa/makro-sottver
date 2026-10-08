/**
 * Live preview of a macro body. Uses the shared template engine (renderTemplate) per variable so that every
 * inserted value can be highlighted: sample values, inline fallbacks and "[ENTER …]" placeholders.
 */
import { memo, useMemo, type ReactNode } from 'react';
import { PLACEHOLDER_RE, parseTemplate, renderTemplate } from '../../../shared/template';

function markPlaceholders(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <mark key={`${keyPrefix}-p${n++}`} className="placeholder-mark" title="Placeholder the agent must fill before sending">
        {m[0]}
      </mark>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface PreviewStats {
  placeholders: number;
  fallbacks: number;
  filled: number;
}

export function usePreview(body: string, values: Record<string, string>): { nodes: ReactNode[]; stats: PreviewStats } {
  return useMemo(() => {
    const nodes: ReactNode[] = [];
    const stats: PreviewStats = { placeholders: 0, fallbacks: 0, filled: 0 };
    parseTemplate(body).forEach((t, i) => {
      if (t.kind === 'text') {
        nodes.push(...markPlaceholders(t.text, `t${i}`));
        return;
      }
      const r = renderTemplate(t.raw, values);
      if (r.placeholders.length) {
        stats.placeholders++;
        nodes.push(
          <mark key={`v${i}`} className="placeholder-mark" title={`{{${t.name}}} has no value: the agent fills it in`}>
            {r.text}
          </mark>,
        );
      } else if (r.usedFallback.length) {
        stats.fallbacks++;
        nodes.push(
          <mark key={`v${i}`} className="lib-var-fallback" title={`{{${t.name}}} unknown: fallback text is used`}>
            {r.text}
          </mark>,
        );
      } else {
        stats.filled++;
        nodes.push(
          <mark key={`v${i}`} className="lib-var-filled" title={`{{${t.name}}} (sample value)`}>
            {r.text}
          </mark>,
        );
      }
    });
    return { nodes, stats };
  }, [body, values]);
}

export const TemplatePreview = memo(function TemplatePreview({ nodes, empty }: { nodes: ReactNode[]; empty: boolean }) {
  return (
    <div className="lib-preview" aria-label="Preview">
      {empty ? <span className="muted">The preview appears here as you type.</span> : nodes}
    </div>
  );
});
