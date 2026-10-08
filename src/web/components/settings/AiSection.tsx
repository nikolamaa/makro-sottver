/**
 * Settings > AI assistant: provider choice, Anthropic key/model/budget/usage, Ollama connection.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AiEffort, AiProviderId, AppSettings, UsageSummary } from '../../../shared/types';
import { api } from '../../api';
import { actions, useStore } from '../../store';
import { Badge, Button, Spinner, toast } from '../../ui';
import { Meter, NumberSetting, RadioCards, Segmented, SectionCard, SettingRow, TextSetting, Toggle, type RadioCardOption } from './controls';
import { errorMessage, formatInt, formatUsd } from './settingsUtils';
import type { SettingsPatch } from './useSettingsSaver';

interface ModelInfo {
  id: string;
  label: string;
  note: string;
  /** USD per million tokens. */
  inPrice: number;
  outPrice: number;
}

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'recommended, cheapest', inPrice: 0.1, outPrice: 0.5 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'more nuanced wording', inPrice: 2, outPrice: 10 },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'most capable, slowest', inPrice: 4, outPrice: 20 },
];

/** Typical personalization request: macro + message + instructions in, one reply out. */
const TYPICAL_IN_TOKENS = 2000;
const TYPICAL_OUT_TOKENS = 400;

function perReplyUsd(m: ModelInfo): number {
  return (TYPICAL_IN_TOKENS * m.inPrice + TYPICAL_OUT_TOKENS * m.outPrice) / 1_000_000;
}

function price(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${n}`;
}

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function validateUrl(v: string): string | null {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Use an http:// or https:// address';
  } catch {
    return 'Enter a full URL, e.g. http://127.0.0.1:11434';
  }
}

const EFFORTS: { value: AiEffort; label: string; title: string }[] = [
  { value: 'low', label: 'Low', title: 'Fastest and cheapest - enough for polishing macros' },
  { value: 'medium', label: 'Medium', title: 'More careful with multi-question messages' },
  { value: 'high', label: 'High', title: 'Slowest; for complex or sensitive cases' },
];

export function AiSection({
  settings,
  update,
  applyServerSettings,
}: {
  settings: AppSettings;
  update: (patch: SettingsPatch) => void;
  applyServerSettings: (s: AppSettings) => void;
}) {
  const ai = settings.ai;
  const strictLocal = settings.privacy.strictLocal;
  const health = useStore((s) => s.health);
  const model = ANTHROPIC_MODELS.find((m) => m.id === ai.anthropicModel) ?? ANTHROPIC_MODELS[0]!;

  const providerOptions: RadioCardOption<AiProviderId>[] = [
    {
      value: 'none',
      title: 'Off',
      subtitle: 'Free, instant (template only)',
      description: 'Replies are built from your macros and the details found in the message. Nothing leaves this computer.',
    },
    {
      value: 'anthropic',
      title: model.label,
      subtitle: `Cloud, about ${formatUsd(perReplyUsd(model))} per reply`,
      description: 'Smoothest wording and combined answers for multi-question messages. Needs an Anthropic API key.',
      badge: strictLocal ? <Badge tone="warning">blocked by strict local</Badge> : undefined,
    },
    {
      value: 'ollama',
      title: 'Ollama',
      subtitle: 'Local & free (needs Ollama installed)',
      description: 'Runs an open model on this computer. Private, but slower without a good GPU.',
    },
  ];

  const aiHealth = health && health.ai.provider === ai.provider ? health.ai : null;

  return (
    <SectionCard
      id="st-ai"
      title="AI assistant"
      description="Optional. MacroPilot works fully without AI - AI only polishes wording, adapts tone and merges answers for messages with several questions."
    >
      <RadioCards name="ai-provider" label="AI provider" value={ai.provider} options={providerOptions} onChange={(provider) => update({ ai: { provider } })} />

      {ai.provider !== 'none' && aiHealth ? (
        <div className="st-status-line" aria-live="polite">
          <Badge tone={aiHealth.ready ? 'success' : 'warning'}>{aiHealth.ready ? 'Ready' : 'Not ready'}</Badge>
          <span className="muted small">{aiHealth.detail}</span>
        </div>
      ) : null}

      {ai.provider === 'anthropic' && strictLocal ? (
        <div className="st-callout st-callout-warning" role="note">
          <span>Strict local mode is on, so Claude will not be called. Turn it off to use the cloud model.</span>
          <Button size="sm" onClick={() => update({ privacy: { strictLocal: false } })}>
            Turn off strict local
          </Button>
        </div>
      ) : null}

      {ai.provider === 'anthropic' ? <AnthropicSettings settings={settings} update={update} applyServerSettings={applyServerSettings} /> : null}
      {ai.provider === 'ollama' ? <OllamaSettings settings={settings} update={update} /> : null}

      {ai.provider !== 'none' ? (
        <div className="st-sub">
          <SettingRow label="Effort" hint="How much the model thinks before answering. Low is fastest and cheapest.">
            <Segmented name="ai-effort" label="Effort" value={ai.effort} options={EFFORTS} onChange={(effort) => update({ ai: { effort } })} />
          </SettingRow>
          <Toggle
            label="Polish replies automatically"
            hint="Run AI personalization as soon as you pick a macro. Off: press the AI button only when you need it."
            checked={ai.autoPolish}
            onChange={(autoPolish) => update({ ai: { autoPolish } })}
          />
          <TestConnection />
        </div>
      ) : null}

      {ai.provider !== 'none' ? <UsagePanel provider={ai.provider} budget={ai.monthlyBudgetUsd} /> : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------

function AnthropicSettings({
  settings,
  update,
  applyServerSettings,
}: {
  settings: AppSettings;
  update: (patch: SettingsPatch) => void;
  applyServerSettings: (s: AppSettings) => void;
}) {
  const ai = settings.ai;
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const model = ANTHROPIC_MODELS.find((m) => m.id === ai.anthropicModel);
  const known = model !== undefined;

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const apiKey = keyDraft.trim();
    if (!apiKey || busy) return;
    if (apiKey.length < 10) {
      toast('That does not look like a full API key', 'danger');
      return;
    }
    setBusy('save');
    try {
      const result = await api('PUT /api/settings/anthropic-key', { body: { apiKey } });
      applyServerSettings(result);
      setKeyDraft('');
      toast('API key saved (encrypted)', 'success');
      actions.refreshHealth().catch((err: unknown) => toast(errorMessage(err), 'danger'));
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    if (busy) return;
    setBusy('remove');
    try {
      const result = await api('DELETE /api/settings/anthropic-key');
      applyServerSettings(result);
      toast('API key removed', 'success');
      actions.refreshHealth().catch((err: unknown) => toast(errorMessage(err), 'danger'));
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-sub">
      <SettingRow
        label="Anthropic API key"
        htmlFor="st-anthropic-key"
        wide
        hint={
          <>
            Create one at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer noopener">
              console.anthropic.com
            </a>
            . It is stored encrypted on this computer and never shown again.
          </>
        }
      >
        <div className="st-key">
          <Badge tone={ai.anthropicKeySet ? 'success' : 'warning'}>{ai.anthropicKeySet ? '✓ Key saved' : 'No key'}</Badge>
          <form className="st-key-form" onSubmit={(e) => void saveKey(e)}>
            <input
              id="st-anthropic-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={ai.anthropicKeySet ? 'Paste a new key to replace it' : 'sk-ant-...'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              aria-label="Anthropic API key"
            />
            <Button type="submit" variant="primary" disabled={!keyDraft.trim() || busy !== null}>
              {busy === 'save' ? <Spinner label="Saving" /> : null}
              Save
            </Button>
          </form>
          {ai.anthropicKeySet ? (
            <Button variant="danger" onClick={() => void removeKey()} disabled={busy !== null}>
              {busy === 'remove' ? <Spinner label="Removing" /> : null}
              Remove
            </Button>
          ) : null}
        </div>
      </SettingRow>

      <SettingRow
        label="Model"
        htmlFor="st-anthropic-model"
        wide
        hint={
          known ? (
            <>
              {price(model.inPrice)} input / {price(model.outPrice)} output per million tokens - about {formatUsd(perReplyUsd(model))} per
              reply. Haiku is plenty for support replies.
            </>
          ) : (
            'Custom model ID set outside this list.'
          )
        }
      >
        <select
          id="st-anthropic-model"
          className="st-model-select"
          value={ai.anthropicModel}
          onChange={(e) => update({ ai: { anthropicModel: e.target.value } })}
        >
          {ANTHROPIC_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} - {m.note} ({price(m.inPrice)} / {price(m.outPrice)} per MTok)
            </option>
          ))}
          {!known ? <option value={ai.anthropicModel}>{ai.anthropicModel} (custom)</option> : null}
        </select>
      </SettingRow>

      <SettingRow label="Monthly budget" htmlFor="st-budget" hint="Hard cap per calendar month. AI pauses once it is reached. 0 = no cap.">
        <NumberSetting
          id="st-budget"
          value={ai.monthlyBudgetUsd}
          min={0}
          max={1000}
          step={0.5}
          prefix="$"
          suffix="USD"
          onCommit={(monthlyBudgetUsd) => update({ ai: { monthlyBudgetUsd } })}
        />
      </SettingRow>

      <Toggle
        label="Pseudonymize personal data"
        hint="Replace emails, names, wallet addresses with tokens before sending to the cloud. Real values are put back locally."
        checked={ai.pseudonymize}
        onChange={(pseudonymize) => update({ ai: { pseudonymize } })}
      />
    </div>
  );
}

function OllamaSettings({ settings, update }: { settings: AppSettings; update: (patch: SettingsPatch) => void }) {
  const ai = settings.ai;
  return (
    <div className="st-sub">
      <SettingRow label="Ollama URL" htmlFor="st-ollama-url" hint="Where Ollama is running. The default works for a standard install.">
        <TextSetting
          id="st-ollama-url"
          value={ai.ollamaUrl}
          required
          mono
          validate={validateUrl}
          placeholder="http://127.0.0.1:11434"
          onCommit={(ollamaUrl) => update({ ai: { ollamaUrl } })}
        />
      </SettingRow>
      <SettingRow
        label="Model"
        htmlFor="st-ollama-model"
        hint={
          <>
            Install Ollama from{' '}
            <a href="https://ollama.com/download" target="_blank" rel="noreferrer noopener">
              ollama.com
            </a>
            , then run <code className="st-code">ollama pull {ai.ollamaModel || 'qwen3:4b'}</code>
          </>
        }
      >
        <TextSetting id="st-ollama-model" value={ai.ollamaModel} required mono placeholder="qwen3:4b" onCommit={(ollamaModel) => update({ ai: { ollamaModel } })} />
      </SettingRow>
    </div>
  );
}

function TestConnection() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await api('POST /api/ai/test');
      toast(res.detail || (res.ok ? 'Connection works' : 'Connection failed'), res.ok ? 'success' : 'danger', 4000);
      actions.refreshHealth().catch((err: unknown) => toast(errorMessage(err), 'danger'));
      window.dispatchEvent(new Event(USAGE_REFRESH_EVENT));
    } catch (err) {
      toast(errorMessage(err), 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label="Connection" hint="Sends a tiny test request with the current settings.">
      <Button onClick={() => void run()} disabled={busy}>
        {busy ? <Spinner label="Testing" /> : null}
        Test connection
      </Button>
    </SettingRow>
  );
}

const USAGE_REFRESH_EVENT = 'macropilot:usage-refresh';

function UsagePanel({ provider, budget }: { provider: AiProviderId; budget: number }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const u = await api('GET /api/usage', { signal });
      setUsage(u);
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      const msg = errorMessage(err);
      setError(msg);
      toast(`Could not load AI usage: ${msg}`, 'danger');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    const onRefresh = () => void load();
    window.addEventListener(USAGE_REFRESH_EVENT, onRefresh);
    return () => {
      ctrl.abort();
      window.removeEventListener(USAGE_REFRESH_EVENT, onRefresh);
    };
  }, [load]);

  // The server reports the budget from saved settings; prefer the live value while editing.
  const cap = budget;
  const pct = usage && cap > 0 ? Math.min(100, (usage.costUsd / cap) * 100) : 0;

  return (
    <div className="st-usage" aria-busy={loading}>
      <div className="st-usage-head">
        <h3>Usage {usage ? <span className="muted">- {monthLabel(usage.month)}</span> : null}</h3>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh usage">
          {loading ? <Spinner label="Loading usage" /> : '↻'} Refresh
        </Button>
      </div>
      {error && !usage ? (
        <p className="small error">Usage is unavailable: {error}</p>
      ) : (
        <>
          <dl className="st-stats">
            <div>
              <dt>Requests</dt>
              <dd>{usage ? formatInt(usage.requests) : '-'}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd title={usage ? `${formatInt(usage.inputTokens)} in / ${formatInt(usage.outputTokens)} out` : undefined}>
                {usage ? formatInt(usage.inputTokens + usage.outputTokens) : '-'}
              </dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{usage ? formatUsd(usage.costUsd, 4) : '-'}</dd>
            </div>
          </dl>
          {provider === 'ollama' && usage && usage.costUsd === 0 ? <p className="small muted">Ollama runs locally - it never costs anything.</p> : null}
          {cap > 0 ? (
            <div className="st-budget">
              <Meter value={usage?.costUsd ?? 0} max={cap} label="Monthly AI budget used" />
              <span className="small muted">
                {formatUsd(usage?.costUsd ?? 0, 4)} of {formatUsd(cap, 2)} budget ({pct.toFixed(pct < 10 ? 1 : 0)}%)
              </span>
            </div>
          ) : (
            <p className="small muted">No monthly cap set.</p>
          )}
        </>
      )}
    </div>
  );
}
