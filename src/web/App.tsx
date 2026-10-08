import { useEffect } from 'react';
import { actions, useStore, type Page } from './store';
import { useHotkeys } from './hotkeys';
import { Badge, Kbd, Spinner, Toaster } from './ui';
import { AssistPage } from './pages/AssistPage';
import { LibraryPage } from './pages/LibraryPage';
import { ImportPage } from './pages/ImportPage';
import { SettingsPage } from './pages/SettingsPage';
import { QuickSearch } from './components/QuickSearch';
import { Onboarding } from './components/Onboarding';

const NAV: { page: Page; label: string; combo: string }[] = [
  { page: 'assist', label: 'Assist', combo: 'alt+shift+1' },
  { page: 'library', label: 'Library', combo: 'alt+shift+2' },
  { page: 'import', label: 'Import / Export', combo: 'alt+shift+3' },
  { page: 'settings', label: 'Settings', combo: 'alt+shift+4' },
];

function useTheme() {
  const theme = useStore((s) => s.settings?.ui.theme ?? 'system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

export function App() {
  const page = useStore((s) => s.page);
  const loaded = useStore((s) => s.loaded);
  const loadError = useStore((s) => s.loadError);
  const health = useStore((s) => s.health);
  useTheme();

  useEffect(() => {
    void actions.loadAll();
  }, []);

  useHotkeys(Object.fromEntries(NAV.map((n) => [n.combo, () => actions.navigate(n.page)])), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            M
          </span>
          MacroPilot
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <button
              key={n.page}
              type="button"
              className={`nav-item ${page === n.page ? 'active' : ''}`}
              onClick={() => actions.navigate(n.page)}
              title={n.combo}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="muted small">
            <Kbd combo="mod+k" /> search
          </span>
          {health ? (
            <>
              <Badge tone={health.ai.ready ? 'success' : 'neutral'} title={health.ai.detail}>
                AI: {health.ai.provider === 'none' ? 'off' : health.ai.provider}
              </Badge>
              <Badge tone={health.embeddings.state === 'ready' ? 'info' : 'warning'} title={health.embeddings.detail}>
                {health.embeddings.provider}
              </Badge>
              <Badge tone="success" title="All data is encrypted at rest (AES-256-GCM)">
                🔒 encrypted
              </Badge>
            </>
          ) : null}
        </div>
      </header>
      <main className="main">
        {!loaded ? (
          <div className="center">
            <Spinner /> Loading…
          </div>
        ) : loadError ? (
          <div className="center error">Could not reach the MacroPilot server: {loadError}</div>
        ) : page === 'assist' ? (
          <AssistPage />
        ) : page === 'library' ? (
          <LibraryPage />
        ) : page === 'import' ? (
          <ImportPage />
        ) : (
          <SettingsPage />
        )}
      </main>
      <QuickSearch />
      <Onboarding />
      <Toaster />
    </div>
  );
}
