// Deterministic keyword / pattern pre-check for high-risk and crisis language
// Note: As documented in the work plan, deterministic keyword filters cannot catch
// subtle/indirect phrasing and may occasionally over-trigger on idiomatic speech.
// This is intentional as a fast, offline safety backstop before LLM processing.

const CRISIS_PATTERNS = [
  {
    type: 'suicide_intent',
    pattern: /\b(kill(ing)?\s+myself|end(ing)?\s+my\s+life|suicid(e|al)|want\s+to\s+die|commit(ting)?\s+suicide|better\s+off\s+dead|no\s+reason\s+to\s+live)\b/i
  },
  {
    type: 'self_harm_method',
    pattern: /\b(slit\s+my\s+(wrist|wrists|throat)|overdose|hang\s+myself|shoot\s+myself|jump\s+off\s+(a\s+)?(bridge|building|roof)|swallow\s+(a\s+bottle\s+of\s+)?pills)\b/i
  },
  {
    type: 'self_harm',
    pattern: /\b(cut(ting)?\s+myself|burn(ing)?\s+myself|harm(ing)?\s+myself|hurt(ing)?\s+myself\s+badly)\b/i
  },
  {
    type: 'imminent_danger',
    pattern: /\b(going\s+to\s+die\s+tonight|goodbye\s+everyone\s+forever|wrote\s+my\s+suicide\s+note|saying\s+my\s+last\s+goodbye)\b/i
  }
];

export function checkCrisisKeywords(text) {
  if (!text || typeof text !== 'string') return null;

  for (const { type, pattern } of CRISIS_PATTERNS) {
    if (pattern.test(text)) {
      return { triggered: true, triggerType: type };
    }
  }

  return null;
}
