/**
 * Settings > Search & matching: embedding provider and live status of the embedder.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, EmbedderStatus, EmbeddingProviderId } from '../../../shared/types';
import { actions, useStore } from '../../store';
import { Badge, Spinner } from '../../ui';
import { SectionCard, SettingRow, TextSetting } from './controls';
import { embeddingSwitchSettled } from './settingsUtils';
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

const SWITCHING_TEXT: Record<EmbeddingProviderId, string> = {
  auto: 'Looking for the local neural model (downloaded once, ~35 MB)...',
  builtin: 'Switching to the built-in engine...',
  transformers: 'Loading the local neural model. The first time it is downloaded (~35 MB)...',
  ollama: 'Connecting to Ollama...',
};

const POLL_MS = 2000;
/** How long to wait for the server to switch engines (first download of the neural model can take a while). */
const SWITCH_WATCH_MS = 3 * 60_000;

/**
 * Keeps health.embeddings fresh while a model is loading and after the engine was changed. The server keeps
 * reporting the previous engine (as "ready") until the new one has loaded, so polling only while state is
 * 'loading' would leave a stale status on screen.
 */
function useEmbeddingSwitchWatch(settings: AppSettings, status: EmbedderStatus | null) {
  const emb = settings.embeddings;
  const target = `${emb.provider}|${emb.provider === 'ollama' ? `${emb.ollamaModel}|${settings.ai.ollamaUrl}` : ''}`;
  const prevTarget = useRef(target);
  const [watching, setWatching] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (prevTarget.current === target) return;
    prevTarget.current = target;
    setWatching(true);
    setTimedOut(false);
  }, [target]);

  const settled = embeddingSwitchSettled(emb, status);
  useEffect(() => {
    if (watching && settled) setWatching(false);
  }, [watching, settled]);

  const loading = status?.state === 'loading';
  const polling = loading || (watching && !settled);
  useEffect(() => {
    if (!polling) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (!loading && Date.now() - started > SWITCH_WATCH_MS) {
        clearInterval(id);
        setWatching(false);
        setTimedOut(true);
        return;
      }
      actions.refreshHealth().catch(() => {
        /* transient; the next tick retries and the status line shows the last known state */
      });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, loading]);

  return { switching: watching && !settled, stillOld: timedOut && !settled && emb.provider !== 'auto' };
}

export function SearchSection({ settings, update }: { settings: AppSettings; update: (patch: SettingsPatch) => void }) {
  const emb = settings.embeddings;
  const status = useStore((s) => s.health?.embeddings ?? null);
  const current = PROVIDERS.find((p) => p.value === emb.provider) ?? PROVIDERS[0]!;
  const { switching, stillOld } = useEmbeddingSwitchWatch(settings, status);

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
      {switching ? (
        <p className="st-switch-note muted small" role="status">
          <Spinner label="Switching engine" /> {SWITCHING_TEXT[emb.provider]} Search keeps working meanwhile.
        </p>
      ) : stillOld ? (
        <p className="st-switch-note st-switch-note-warning small" role="status">
          Still using {status?.provider ?? 'the previous engine'}. The selected engine could not be loaded, so
          MacroPilot keeps using the built-in one. {emb.provider === 'ollama' ? 'Check that Ollama is running and the model is installed.' : ''}
        </p>
      ) : null}
    </SectionCard>
  );
}
