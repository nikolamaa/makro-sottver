/** Reply body editor: textarea + "Insert variable" (at the cursor) + detected variables + live preview. */
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { listVariables, parseTemplate } from '../../../shared/template';
import { STANDARD_VARIABLES } from '../../../shared/types';
import { useHotkeys } from '../../hotkeys';
import { readLocal, writeLocal, LIMITS, SAMPLE_VALUES } from './model';
import { TemplatePreview, usePreview } from './TemplatePreview';
import { isModalOpen } from './Modals';
import { VariableMenu } from './VariableMenu';

const SAMPLES_KEY = 'macropilot.library.previewSamples';
const NO_VALUES: Record<string, string> = {};
const STANDARD = new Set<string>(STANDARD_VARIABLES);

export function BodyEditor({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string;
  onChange: (body: string) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const id = 'lib-field-body';
  const taRef = useRef<HTMLTextAreaElement>(null);
  const touched = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [samples, setSamples] = useState(() => readLocal(SAMPLES_KEY) !== '0');

  const variables = useMemo(() => listVariables(value), [value]);
  // The preview may lag a frame behind fast typing; the textarea never does.
  const previewBody = useDeferredValue(value);
  const { nodes, stats } = usePreview(previewBody, samples ? SAMPLE_VALUES : NO_VALUES);

  const insert = useCallback(
    (token: string) => {
      const ta = taRef.current;
      if (!ta) {
        onChange(value + token);
        return;
      }
      // Never-focused textarea: append at the end instead of the (meaningless) default caret at 0.
      const start = touched.current ? ta.selectionStart : ta.value.length;
      const end = touched.current ? ta.selectionEnd : ta.value.length;
      ta.focus();
      ta.setSelectionRange(start, end);
      // execCommand keeps the browser's native undo stack (Ctrl+Z) working; fall back to a manual splice.
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, token);
      } catch {
        ok = false;
      }
      if (!ok || ta.value === value) {
        const next = value.slice(0, start) + token + value.slice(end);
        onChange(next);
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(start + token.length, start + token.length);
        });
      }
    },
    [onChange, value],
  );

  const onMenuOpenChange = useCallback((open: boolean, restoreFocus = true) => {
    setMenuOpen(open);
    if (!open && restoreFocus) requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  useHotkeys({ 'alt+i': () => !disabled && !isModalOpen() && setMenuOpen(true) }, [disabled]);

  /** Select the first occurrence of a variable in the textarea. */
  const reveal = (name: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const tok = parseTemplate(value).find((t) => t.kind === 'var' && t.name === name);
    if (!tok) return;
    ta.focus();
    ta.setSelectionRange(tok.start, tok.end);
  };

  const toggleSamples = (on: boolean) => {
    setSamples(on);
    writeLocal(SAMPLES_KEY, on ? '1' : '0');
  };

  return (
    <div className="lib-body">
      <div className="lib-body-edit lib-field">
        <div className="lib-field-top">
          <label className="field-label" htmlFor={id}>
            Reply text
          </label>
          <span className="lib-field-aside">
            <span className={`small ${value.length > LIMITS.body ? 'error' : 'muted'}`}>
              {value.length.toLocaleString('en')}/{LIMITS.body.toLocaleString('en')}
            </span>
            <VariableMenu open={menuOpen} onOpenChange={onMenuOpenChange} onInsert={insert} disabled={disabled} />
          </span>
        </div>
        <textarea
          id={id}
          ref={taRef}
          className="lib-body-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            touched.current = true;
          }}
          readOnly={disabled}
          rows={12}
          spellCheck
          placeholder={'Hi {{user|there}},\n\nThanks for reaching out! …'}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-vars${error ? ` ${id}-msg` : ''}`}
        />
        {error ? (
          <span className="lib-field-msg lib-field-error" id={`${id}-msg`} role="alert">
            {error}
          </span>
        ) : null}
        <div className="lib-vars" id={`${id}-vars`}>
          <span className="field-label">Variables</span>
          {variables.length === 0 ? (
            <span className="muted small">None yet. Use “Insert variable” or type {'{{name}}'}.</span>
          ) : (
            variables.map((v) => {
              const custom = !STANDARD.has(v);
              return (
                <button
                  type="button"
                  key={v}
                  tabIndex={-1}
                  className={`lib-var-chip${custom ? ' is-custom' : ''}`}
                  onClick={() => reveal(v)}
                  title={custom ? 'Custom variable: the agent fills it in manually' : 'Standard variable: filled automatically when known'}
                >
                  {`{{${v}}}`}
                  {custom ? <span className="lib-var-chip-tag">custom</span> : null}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="lib-body-preview lib-field">
        <div className="lib-field-top">
          <span className="field-label">Preview</span>
          <label className="lib-check small lib-field-aside">
            <input type="checkbox" checked={samples} onChange={(e) => toggleSamples(e.target.checked)} />
            Sample values
          </label>
        </div>
        <TemplatePreview nodes={nodes} empty={!previewBody.trim()} />
        <div className="lib-preview-legend small muted" aria-live="polite">
          {stats.placeholders ? (
            <span>
              <mark className="placeholder-mark">[ENTER …]</mark> {stats.placeholders} to fill in
            </span>
          ) : null}
          {stats.fallbacks ? (
            <span>
              <mark className="lib-var-fallback">fallback</mark> {stats.fallbacks}
            </span>
          ) : null}
          {stats.filled ? (
            <span>
              <mark className="lib-var-filled">sample</mark> {stats.filled}
            </span>
          ) : null}
          {!stats.placeholders && !stats.fallbacks && !stats.filled ? <span>Greeting and tone are added when the macro is used.</span> : null}
        </div>
      </div>
    </div>
  );
}
