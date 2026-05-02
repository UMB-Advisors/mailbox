// STAQPRO-153 — canonical shape for mailbox.persona.statistical_markers and
// mailbox.persona.category_exemplars. The DB column is JSONB so the shape
// here is the application contract; rows written before this contract was
// defined (e.g. manual edits via STAQPRO-149) may have arbitrary keys and
// MUST round-trip cleanly via the openSchema in lib/schemas/persona.ts.

import type { Category } from '@/lib/classification/prompt';

export interface PerCategoryMarkers {
  sample_size: number;
  avg_sentence_words: number;
  formality_score: number; // 0..1 — see lib/persona/extract.ts
}

export interface StatisticalMarkers {
  source_email_count: number;
  avg_sentence_words: number;
  median_sentence_words: number;
  formality_score: number;
  sign_off_top: string[];
  greeting_top: string[];
  common_phrases: string[];
  emoji_count: number;
  per_category: Partial<Record<Category, PerCategoryMarkers>>;
  extracted_at: string; // ISO

  // STAQPRO-195 operator-set override layer. These are NOT produced by
  // extractPersona() — they're set via the persona settings UI and trump the
  // extracted/derived defaults in lib/drafting/persona.ts:resolvePersonaContext.
  tone?: string;
  signoff?: string;
  operator_first_name?: string;
  operator_brand?: string;
}

export interface CategoryExemplar {
  inbound_subject: string | null;
  inbound_body_excerpt: string;
  sent_body: string;
  sent_at: string;
}

export type CategoryExemplars = Partial<Record<Category, CategoryExemplar[]>>;
