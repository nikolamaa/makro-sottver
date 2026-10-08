/**
 * Settings sections: Replies, Recommendations, Accuracy checks, Privacy, Appearance.
 */
import { useId, useMemo } from 'react';
import { renderTemplate } from '../../../shared/template';
import type { AppSettings } from '../../../shared/types';
import { NumberSetting, PhaseBadge, Segmented, SectionCard, SettingRow, TextSetting, Toggle } from './controls';
import type { SettingsPatch } from './useSettingsSaver';

interface SectionProps {
  settings: AppSettings;
  update: (patch: SettingsPatch) => void;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

export function RepliesSection({ settings, update }: SectionProps) {
  const p = settings.personalization;
  const preview = useMemo(() => {
    const named = renderTemplate(p.greeting, { user: 'Marko', username: 'marko99' }).text;
    const anonymous = renderTemplate(p.greeting, { user: p.userFallback }).text;
    return { named, anonymous };
  }, [p.greeting, p.userFallback]);

  return (
    <SectionCard id="st-replies" title="Replies" description="How macros are turned into a reply for the customer.">
      <SettingRow
        label="Greeting"
        htmlFor="st-greeting"
        hint={
          <>
            Added when a macro has no greeting. Use <code className="st-code">{'{{user}}'}</code> for the customer&apos;s name.
          </>
        }
      >
        <TextSetting id="st-greeting" value={p.greeting} placeholder="Hi {{user}}," onCommit={(greeting) => update({ personalization: { greeting } })} />
      </SettingRow>
      <SettingRow
        label="Name fallback"
        htmlFor="st-user-fallback"
        hint={
          <>
            Used for <code className="st-code">{'{{user}}'}</code> when the name is unknown.
          </>
        }
      >
        <TextSetting id="st-user-fallback" value={p.userFallback} placeholder="there" onCommit={(userFallback) => update({ personalization: { userFallback } })} />
      </SettingRow>
      {p.greeting.trim() ? (
        <div className="st-preview" aria-label="Greeting preview">
          <span className="muted small">Preview</span>
          <span className="st-preview-line">{preview.named}</span>
          <span className="st-preview-line">{preview.anonymous}</span>
        </div>
      ) : null}
      <Toggle
        label="Adapt tone to the customer's mood"
        hint="Adds a short, sincere empathy line for frustrated customers and keeps a calm tone in responsible-gambling cases."
        checked={p.toneAdjust}
        onChange={(toneAdjust) => update({ personalization: { toneAdjust } })}
      />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

const MAX_RESULTS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
];

export function RecommendationsSection({ settings, update }: SectionProps) {
  const r = settings.recommendation;
  const rangeId = useId();
  const hintId = `${rangeId}-hint`;
  const value = Math.round(r.minConfidence);
  return (
    <SectionCard id="st-recs" title="Recommendations" description="Which macros Assist suggests for a customer message.">
      <div className="st-row">
        <div className="st-row-text">
          <label className="st-row-label" htmlFor={rangeId}>
            Minimum confidence
          </label>
          <span className="st-row-hint" id={hintId}>
            Below this, Assist shows &quot;No good match&quot; and offers to draft a new reply instead of guessing.
          </span>
        </div>
        <div className="st-row-control st-range">
          <input
            id={rangeId}
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            aria-describedby={hintId}
            aria-valuetext={`${value}%`}
            onChange={(e) => update({ recommendation: { minConfidence: Number(e.target.value) } })}
          />
          <output htmlFor={rangeId} className="st-range-value">
            {value}%
          </output>
        </div>
      </div>
      <SettingRow label="Suggestions shown" hint="How many macros to recommend per message (best first).">
        <Segmented
          name="max-results"
          label="Suggestions shown"
          value={r.maxResults}
          options={MAX_RESULTS}
          onChange={(maxResults) => update({ recommendation: { maxResults } })}
        />
      </SettingRow>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Accuracy checks (Phase 3)
// ---------------------------------------------------------------------------

const INTERVALS: { hours: number; label: string }[] = [
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Every day' },
  { hours: 48, label: 'Every 2 days (recommended)' },
  { hours: 72, label: 'Every 3 days' },
  { hours: 168, label: 'Every week' },
];

export function AccuracySection({ settings, update }: SectionProps) {
  const a = settings.accuracy;
  const known = INTERVALS.some((i) => i.hours === a.intervalHours);
  return (
    <SectionCard
      id="st-accuracy"
      title="Accuracy checks"
      badge={<PhaseBadge>Coming in Phase 3</PhaseBadge>}
      description="Compares the facts in your macros (limits, times, links) with the Stake Help Center and your other sources. Changes are proposed for your approval, never applied silently."
    >
      <Toggle label="Check facts automatically" checked={a.enabled} onChange={(enabled) => update({ accuracy: { enabled } })} />
      <SettingRow label="How often" htmlFor="st-accuracy-interval" hint="Every 2 days balances freshness against load on the sources.">
        <select
          id="st-accuracy-interval"
          value={a.intervalHours}
          disabled={!a.enabled}
          onChange={(e) => update({ accuracy: { intervalHours: Number(e.target.value) } })}
        >
          {INTERVALS.map((i) => (
            <option key={i.hours} value={i.hours}>
              {i.label}
            </option>
          ))}
          {!known ? <option value={a.intervalHours}>Every {a.intervalHours} hours</option> : null}
        </select>
      </SettingRow>
      <Toggle
        label="Auto-approve minor changes"
        hint="Only wording or formatting. Changes to amounts, limits, times or links always wait for you."
        checked={a.autoApproveMinor}
        disabled={!a.enabled}
        onChange={(autoApproveMinor) => update({ accuracy: { autoApproveMinor } })}
      />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

export function PrivacySection({ settings, update }: SectionProps) {
  const pr = settings.privacy;
  return (
    <SectionCard
      id="st-privacy"
      title="Privacy"
      description="Customer messages are never stored - they are processed in memory and discarded after each request."
    >
      <Toggle
        label="Never send anything to cloud services"
        hint="Strict local mode. Blocks Claude; only built-in features and Ollama on this computer are used."
        checked={pr.strictLocal}
        onChange={(strictLocal) => update({ privacy: { strictLocal } })}
      />
      <SettingRow label="Keep usage statistics for" htmlFor="st-retention" hint="Statistics contain macro IDs and scores only, never message text.">
        <NumberSetting
          id="st-retention"
          value={pr.analyticsRetentionDays}
          min={1}
          max={3650}
          integer
          suffix="days"
          onCommit={(analyticsRetentionDays) => update({ privacy: { analyticsRetentionDays } })}
        />
      </SettingRow>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const THEMES: { value: AppSettings['ui']['theme']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AppearanceSection({ settings, update }: SectionProps) {
  const ui = settings.ui;
  return (
    <SectionCard id="st-appearance" title="Appearance & behavior">
      <SettingRow label="Theme">
        <Segmented name="theme" label="Theme" value={ui.theme} options={THEMES} onChange={(theme) => update({ ui: { theme } })} />
      </SettingRow>
      <Toggle
        label="Read the clipboard automatically"
        hint="When you switch to MacroPilot, Assist pastes the customer message you just copied. The browser may ask for permission once."
        checked={ui.autoReadClipboard}
        onChange={(autoReadClipboard) => update({ ui: { autoReadClipboard } })}
      />
    </SectionCard>
  );
}
