import { z } from 'zod';

export const ANIMATIONS = ['talking', 'listening', 'thinking', 'idle'];
export const GESTURES = ['none', 'nod', 'small_gesture', 'head_tilt'];
export const NOTE_CATEGORIES = [
  'important_event',
  'automatic_thought',
  'explicitly_stated_emotion',
  'goal',
  'coping_strategy',
  'follow_up',
  'preference',
  'safety_concern'
];
export const MEMORY_CATEGORIES = [
  'important_event',
  'recurring_concern',
  'goal',
  'coping_strategy',
  'preference',
  'follow_up',
  'relevant_context'
];
export const RISKS = ['none', 'concern', 'crisis'];

// Note schema
export const NoteSchema = z.object({
  category: z.string().refine(val => NOTE_CATEGORIES.includes(val), {
    message: 'Invalid note category'
  }),
  text: z.string().max(160, 'Note text exceeds 160 characters')
});

// Resource schema
export const ResourceSchema = z.object({
  label: z.string(),
  contact: z.string()
});

// Raw LLM output schema (before audioUrl and degraded are injected by backend)
export const RawLlmOutputSchema = z.object({
  speech: z.string().min(1).max(500),
  animation: z.string().optional().default('talking'),
  gesture: z.string().optional().default('none'),
  takeNote: z.boolean().optional().default(false),
  note: NoteSchema.nullable().optional().default(null),
  risk: z.string().optional().default('none')
});

// Session End summary & memories extraction schema
export const SessionEndExtractionSchema = z.object({
  summary: z.string().max(500),
  memories: z.array(z.object({
    category: z.string().refine(val => MEMORY_CATEGORIES.includes(val), {
      message: 'Invalid memory category'
    }),
    text: z.string().max(200)
  })).max(5).default([])
});

export const PersonalizedCardRequestSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(128),
  consent: z.literal(true),
  memoryIds: z.array(z.string().trim().min(1).max(128))
    .max(3)
    .refine(ids => new Set(ids).size === ids.length, {
      message: 'Memory IDs must be unique'
    })
});

export const CircleCardSuitabilitySchema = z.strictObject({
  assessments: z.array(z.strictObject({
    index: z.number().int().min(0).max(2),
    eligible: z.boolean(),
    confidence: z.enum(['high', 'uncertain']),
    context: z.string().max(120)
  })).max(3)
});

export const CircleControlCardSchema = z.strictObject({
  text: z.string().trim().min(1).max(90),
  category: z.enum(['within_control', 'outside_control']),
  reflection: z.string().trim().min(1).max(180),
  nuanced: z.boolean()
});

export const CircleControlCardsSchema = z.strictObject({
  cards: z.array(CircleControlCardSchema).min(1).max(3)
});

// Full ChatResponse schema per Section 4.2
export const ChatResponseSchema = z.object({
  speech: z.string(),
  animation: z.enum(['talking', 'listening', 'thinking', 'idle']),
  gesture: z.enum(['none', 'nod', 'small_gesture', 'head_tilt']),
  takeNote: z.boolean(),
  note: NoteSchema.nullable(),
  audioUrl: z.string().nullable(),
  risk: z.enum(['none', 'concern', 'crisis']),
  resources: z.array(ResourceSchema).nullable(),
  degraded: z.array(z.string())
});

/**
 * Normalizes raw LLM output, enforcing defaults for unknown enums and matching Section 4.2
 */
export function normalizeLlmResponse(raw, noteFrequencyAllowed = true) {
  let speech = typeof raw.speech === 'string' ? raw.speech.trim() : "I am here with you. Take your time.";
  if (speech.length > 450) {
    // Truncate to sensible length if model rambled
    speech = speech.substring(0, 400).replace(/\s+\S*$/, '') + '.';
  }

  let animation = ANIMATIONS.includes(raw.animation) ? raw.animation : 'talking';
  let gesture = GESTURES.includes(raw.gesture) ? raw.gesture : 'none';
  let risk = RISKS.includes(raw.risk) ? raw.risk : 'none';

  let takeNote = Boolean(raw.takeNote);
  let note = null;

  if (raw.note && typeof raw.note === 'object' && NOTE_CATEGORIES.includes(raw.note.category)) {
    const text = typeof raw.note.text === 'string' ? raw.note.text.slice(0, 160).trim() : '';
    if (text.length > 0) {
      note = {
        category: raw.note.category,
        text
      };
    }
  }

  // takeNote is true ONLY when note is non-null
  if (!note) {
    takeNote = false;
  }

  // If note taking is throttled by frequency limit, suppress takeNote for this turn
  if (!noteFrequencyAllowed && takeNote) {
    takeNote = false;
    note = null;
  }

  return {
    speech,
    animation,
    gesture,
    takeNote,
    note,
    risk
  };
}
