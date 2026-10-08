import { memo, useState } from 'react';
import { placeholderLabel } from '../../../shared/template';
import { MAX_VARIABLE_CHARS } from './variables';

interface VariablesPanelProps {
  /** Variables used by the selected macro(s), excluding {{user}} (it has its own input). */
  names: string[];
  /** Values detected in the customer message, shown as input placeholders. */
  detected: Record<string, string>;
  overrides: Record<string, string>;
  hasSelection: boolean;
  onChange: (name: string, value: string) => void;
}

/** Remembered while the tab is open so the panel keeps its state across page switches. */
let openPreference = true;

function isSet(name: string, detected: Record<string, string>, overrides: Record<string, string>): boolean {
  return Boolean(overrides[name]?.trim() || detected[name]);
}

/** Collapsible list of template variables with detected values and agent overrides. */
export const VariablesPanel = memo(function VariablesPanel({ names, detected, overrides, hasSelection, onChange }: VariablesPanelProps) {
  const [open, setOpen] = useState(openPreference);
  const setCount = names.filter((n) => isSet(n, detected, overrides)).length;
  return (
    <details
      className="panel assist-vars"
      open={open}
      onToggle={(e) => {
        openPreference = e.currentTarget.open;
        setOpen(openPreference);
      }}
    >
      <summary>
        <span className="assist-title">Variables</span>
        {names.length ? (
          <span className="muted small">
            {setCount}/{names.length} set
          </span>
        ) : null}
      </summary>
      {names.length ? (
        <div className="assist-vars-grid">
          {names.map((name) => (
            <label key={name} className="assist-var">
              <span className="assist-var-name mono">{`{{${name}}}`}</span>
              <input
                value={overrides[name] ?? ''}
                placeholder={detected[name] ?? placeholderLabel(name)}
                maxLength={MAX_VARIABLE_CHARS}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onChange(name, e.target.value)}
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="muted small assist-vars-empty">
          {hasSelection ? 'The selected macro has no variables.' : 'Select a macro to see its variables.'}
        </p>
      )}
    </details>
  );
});
