/**
 * Settings > Search & matching: embedding provider and live status of the embedder.
 */
import { useEffect } from 'react';
import type { AppSettings, EmbeddingProviderId } from '../../../shared/types';
import { actions, useStore } from '../../store';
import { Badge, Spinner } from '../../ui';
import { SectionCard, SettingRow, TextSetting } from './controls';
import type { SettingsPatch } from './useSettingsSaver';

const PROVIDERS: { value: EmbeddingProviderId; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic (recommended)', hint: 'Uses the local neural model when available, otherwise the built-in engine.' },
  { value: 'builtin', label: 'Built-in (instant, no download)', hint: 'Keyword and synonym matching. Works everywhere, no download.' },
  {
    value: 'transformers',
    label: 'Local neural model (downloads ~35 MB once)',
    hint: 'Understands meaning, not just words. Runs on this computer after a one-time download.',
  },
  { value: 'ollama', label: 'Ollama embeddings', hint: 'Uses an embedding model served by your local Ollama.' },
];

const POLL_MS = 2000;

export function SearchSection({ settings, update }: { settings: AppSettings; update: (patch: SettingsPatch) => void }) {
  const emb = settings.embeddings;
  const status = useStore((s) => s.health?.embeddings ?? null);
  const current = PROVIDERS.find((p) => p.value === emb.provider) ?? PROVIDERS[0]!;

  // While a model is loading/downloading, keep the status fresh.
  const loading = status?.state === 'loading';
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => {
      actions.refreshHealth().catch(() => {
        /* transient; the next tick retries and the status line shows the last known state */
      });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [loading]);

  return (
    <SectionCard
      id="st-search"
      title="Search & matching"
      description="How MacroPilot understands the meaning of customer messages to find the right macro. Everything runs on this computer."
    >
      <SettingRow label="Matching engine" htmlFor="st-emb-provider" hint={current.hint}>
        <select
          id="st-emb-provider"
          value={emb.provider}
          onChange={(e) => update({ embeddings: { provider: e.target.value as EmbeddingProviderId } })}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingRow>

      {emb.provider === 'ollama' ? (
        <SettingRow
          label="Ollama embedding model"
          htmlFor="st-emb-ollama-model"
          hint={
            <>
              Served by Ollama at the URL from the AI section. Install with <code className="st-code">ollama pull {emb.ollamaModel || 'nomic-embed-text'}</code>
            </>
          }
        >
          <TextSetting
            id="st-emb-ollama-model"
            value={emb.ollamaModel}
            required
            mono
            placeholder="nomic-embed-text"
            onCommit={(ollamaModel) => update({ embeddings: { ollamaModel } })}
          />
        </SettingRow>
      ) : null}

      <SettingRow label="Currently in use" hint={status?.detail || undefined}>
        <div className="st-status" aria-live="polite">
          {status ? (
            <>
              {status.state === 'loading' ? <Spinner label="Loading model" /> : null}
              <Badge tone={status.state === 'ready' ? 'success' : status.state === 'loading' ? 'warning' : 'danger'}>
                {status.state === 'ready' ? 'Ready' : status.state === 'loading' ? 'Loading' : 'Error'}
              </Badge>
              <span className="st-status-text">
                {status.provider}
                {status.model ? <span className="muted"> · {status.model}</span> : null}
              </span>
            </>
          ) : (
            <span className="muted">Unknown</span>
          )}
        </div>
      </SettingRow>
    </SectionCard>
  );
}
