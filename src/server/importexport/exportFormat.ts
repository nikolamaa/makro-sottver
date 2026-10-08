/** Shape of MacroPilot's plaintext JSON export (written by toExportJson, read back by parseImport('json')). */
import type { FactStatus, Id, Intent, IsoDate } from '../../shared/types.js';

export const EXPORT_FORMAT = 'macropilot-macros';
export const EXPORT_VERSION = 1;

export interface ExportedCategory {
  id: Id;
  name: string;
  color: string;
}

export interface ExportedFact {
  key: string;
  statement: string;
  value: string;
  sourceUrl: string | null;
  evidenceQuote: string | null;
  status: FactStatus;
}

export interface ExportedMacro {
  id: Id;
  title: string;
  body: string;
  categoryId: Id | null;
  /** Category name, so the file stays readable and importable without the categories list. */
  category: string | null;
  tags: string[];
  intents: Intent[];
  triggers: string[];
  notes: string;
  shortcut: string;
  isFavorite: boolean;
  archived: boolean;
  facts: ExportedFact[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: IsoDate;
  categories: ExportedCategory[];
  macros: ExportedMacro[];
}
