/** Tiny inline SVG icons for the Library (currentColor, 16px by default, decorative unless labelled). */
import type { ReactNode } from 'react';
import type { VerificationStatus } from '../../../shared/types';
import { VERIFICATION_META } from './model';

function Svg({ children, size = 16, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      className="lib-icon"
    >
      {children}
    </svg>
  );
}

export function StarIcon({ filled, size, label }: { filled: boolean; size?: number; label?: string }) {
  return (
    <Svg size={size} label={label}>
      <path
        d="M8 1.8l1.85 3.86 4.2.55-3.08 2.92.78 4.17L8 11.27 4.25 13.3l.78-4.17L1.95 6.2l4.2-.55L8 1.8z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function ExternalIcon() {
  return (
    <Svg size={12}>
      <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 10v3.5H2.5V4H6" />
    </Svg>
  );
}

export function EditIcon() {
  return (
    <Svg size={14}>
      <path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z" />
    </Svg>
  );
}

export function TrashIcon() {
  return (
    <Svg size={14}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
    </Svg>
  );
}

/** Verification status icon with an accessible label. */
export function VerificationIcon({ status, size = 14 }: { status: VerificationStatus; size?: number }) {
  const meta = VERIFICATION_META[status];
  return (
    <span className={`lib-verif lib-verif-${status}`} title={`${meta.label}: ${meta.description}`}>
      <Svg size={size} label={meta.label}>
        {status === 'verified' ? (
          <>
            <circle cx="8" cy="8" r="6.2" />
            <path d="M5.2 8.2l2 2 3.6-4" />
          </>
        ) : status === 'outdated' ? (
          <>
            <path d="M8 1.8L14.6 13.5H1.4L8 1.8z" />
            <path d="M8 6.2v3.3M8 11.6v.1" />
          </>
        ) : status === 'conflict' ? (
          <>
            <circle cx="8" cy="8" r="6.2" />
            <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="6.2" strokeDasharray="2.4 2" />
          </>
        )}
      </Svg>
    </span>
  );
}
