/**
 * All prompts the app sends to an LLM, with their zod output schemas. Prompts are in English (all customer
 * conversations are English). Each builder returns { system, user, schema }. The system prompts are static
 * strings (good for prompt caching); variable data goes in the user turn inside XML-like tags, and customer
 * text is always wrapped in <customer_message> and declared untrusted.
 */
import { z } from 'zod';
import type { Analysis, Intent } from '../../shared/types.js';

export const PROMPT_VERSION = 1;

export interface PromptSpec<S extends z.ZodType> {
  system: string;
  user: string;
  schema: S;
}

// --- 1. Message analysis ----------------------------------------------------
export const AnalysisSchema = z.object({}); // TODO: intents[{intent, confidence}], sentiment, urgency, questions[{text,intent}], entities, rg_risk, summary
export function analysisPrompt(message: string): PromptSpec<typeof AnalysisSchema> {
  throw new Error('TODO');
}

// --- 2. Macro ranking / re-ranking ------------------------------------------
export interface RankCandidate {
  id: string;
  title: string;
  intents: Intent[];
  summary: string;
  verification: string;
}
export const RankSchema = z.object({}); // TODO: ranked[{id, confidence 0-100, reason}], no_good_match, missing_topics
export function rankPrompt(message: string, analysis: Analysis, candidates: RankCandidate[]): PromptSpec<typeof RankSchema> {
  throw new Error('TODO');
}

// --- 3. Reply personalization -----------------------------------------------
export interface PersonalizePromptInput {
  /** Pseudonymized customer message. */
  message: string;
  analysis: Analysis;
  macros: { title: string; body: string }[];
  facts: { id: string; statement: string; value: string; status: string }[];
  /** Known variable values (pseudonymized where personal). */
  variables: Record<string, string>;
  greeting: string;
  userFallback: string;
}
export const PersonalizeSchema = z.object({}); // TODO: reply, used_fact_ids, unanswered_questions, placeholders, notes_for_agent
export function personalizePrompt(input: PersonalizePromptInput): PromptSpec<typeof PersonalizeSchema> {
  throw new Error('TODO');
}

// --- 4. Draft from scratch (no matching macro) ------------------------------
export interface DraftPromptInput {
  message: string;
  analysis: Analysis;
  /** Verified facts from the library that may be relevant (may be empty). */
  facts: { id: string; statement: string; value: string; sourceUrl: string | null }[];
  greeting: string;
  userFallback: string;
}
export const DraftSchema = z.object({}); // TODO: reply, suggested_title, suggested_intents, placeholders
export function draftPrompt(input: DraftPromptInput): PromptSpec<typeof DraftSchema> {
  throw new Error('TODO');
}

// --- 5. Fact accuracy check (Phase 3) ---------------------------------------
export interface FactCheckInput {
  fact: { key: string; statement: string; value: string };
  passages: { sourceName: string; url: string; heading: string; text: string }[];
}
export const FactCheckSchema = z.object({}); // TODO: verdict, evidence_quote, corrected_statement, corrected_value, confidence, rationale
export function factCheckPrompt(input: FactCheckInput): PromptSpec<typeof FactCheckSchema> {
  throw new Error('TODO');
}

// --- 6. Macro update proposal (Phase 3) -------------------------------------
export interface MacroUpdateInput {
  title: string;
  body: string;
  corrections: { statement: string; oldValue: string; newValue: string; sourceUrl: string; evidenceQuote: string }[];
}
export const MacroUpdateSchema = z.object({}); // TODO: new_body, change_summary, severity minor|major
export function macroUpdatePrompt(input: MacroUpdateInput): PromptSpec<typeof MacroUpdateSchema> {
  throw new Error('TODO');
}
