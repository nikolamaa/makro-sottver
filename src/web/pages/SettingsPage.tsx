/**
 * Settings page. Every field saves on its own (debounced 400 ms) through useSettingsSaver; there is no Save button.
 */
import { useEffect, useState } from 'react';
import { useHotkeys } from '../hotkeys';
import { useStore } from '../store';
import { EmptyState, Kbd, Spinner } from '../ui';
import { AiSection } from '../components/settings/AiSection';
import { SearchSection } from '../components/settings/SearchSection';
import {
  AccuracySection,
  AppearanceSection,
  PrivacySection,
  RecommendationsSection,
  RepliesSection,
} from '../components/settings/GeneralSections';
import { SecuritySection } from '../components/settings/SecuritySection';
import { useSettingsSaver, type SaveState } from '../components/settings/useSettingsSaver';
import './settings.css';

const SECTIONS: { id: string; label: string }[] = [
  { id: 'st-ai', label: 'AI assistant' },
  { id: 'st-search', label: 'Search & matching' },
  { id: 'st-replies', label: 'Replies' },
  { id: 'st-recs', label: 'Recommendations' },
  { id: 'st-accuracy', label: 'Accuracy checks' },
  { id: 'st-privacy', label: 'Privacy' },
  { id: 'st-appearance', label: 'Appearance' },
  { id: 'st-security', label: 'Security' },
];

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Scroll to a section and move focus to its heading (anchors can't be used: the router owns location.hash). */
function goToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  document.getElementById(`${id}-title`)?.focus({ preventScroll: true });
}

function useActiveSection(ready: boolean): string {
  const [active, setActive] = useState(SECTIONS[0]!.id);
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        // The topmost visible section wins.
        let best: string | null = null;
        let bestTop = Infinity;
        for (const [id, top] of visible) {
          if (top < bestTop) {
            best = id;
            bestTop = top;
          }
        }
        if (best) setActive(best);
      },
      { rootMargin: '-12% 0px -60% 0px', threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ready]);
  return active;
}

function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className={`st-save st-save-${state}`} role="status" aria-live="polite">
      {state === 'saving' ? (
        <>
          <Spinner label="Saving" /> Saving...
        </>
      ) : state === 'pending' ? (
        'Unsaved changes...'
      ) : state === 'saved' ? (
        '✓ Saved'
      ) : state === 'error' ? (
        'Not saved'
      ) : (
        'Changes save automatically'
      )}
    </span>
  );
}

export function SettingsPage() {
  const settings = useStore((s) => s.settings);
  const saver = useSettingsSaver();
  const active = useActiveSection(settings !== null);

  useHotkeys({ 'mod+s': () => saver.flush() }, [saver.flush]);

  if (!settings) {
    return (
      <div className="page">
        <EmptyState title="Settings are not available">The MacroPilot server did not return any settings. Reload the page to try again.</EmptyState>
      </div>
    );
  }

  return (
    <div className="page st-page">
      <div className="st-topbar">
        <h1 className="st-title">Settings</h1>
        <SaveIndicator state={saver.state} />
        <span className="st-topbar-hint muted small">
          <Kbd combo="mod+s" /> save now
        </span>
      </div>
      <div className="st-layout">
        <nav className="st-nav" aria-label="Settings sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`st-nav-item ${active === s.id ? 'active' : ''}`}
                  aria-current={active === s.id ? 'true' : undefined}
                  onClick={() => goToSection(s.id)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="st-content">
          <AiSection settings={settings} update={saver.update} applyServerSettings={saver.applyServerSettings} whenSaved={saver.whenIdle} />
          <SearchSection settings={settings} update={saver.update} />
          <RepliesSection settings={settings} update={saver.update} />
          <RecommendationsSection settings={settings} update={saver.update} />
          <AccuracySection settings={settings} update={saver.update} />
          <PrivacySection settings={settings} update={saver.update} />
          <AppearanceSection settings={settings} update={saver.update} />
          <SecuritySection />
        </div>
      </div>
    </div>
  );
}
