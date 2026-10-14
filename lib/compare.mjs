// The models several agents asked the same thing use (lib/groups.mjs). A
// tier — Fast, Balanced or Best — picks a matched model and effort for each
// agent, so a comparison isn't one agent's top model against another's
// cheapest. A model picked by hand for an agent replaces the tier's pick for
// that tier. Kept here rather than in the browser so every device compares
// the same way. Shape:
//   { tier, overrides: { [tier]: { [agent]: { model, effort } } } }
// A null model or effort means the agent's default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.agentdeck');
const FILE = path.join(DIR, 'compare.json');

export const TIERS = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'best', label: 'Best' },
];
const DEFAULT_TIER = 'balanced';
const EFFORT = { fast: 'low', balanced: 'medium', best: 'high' };

// Each agent's model for a tier: the first in its list matching any of the
// patterns, tried in order. Lists put newer models first, so `sol` finds the
// latest Sol. Antigravity CLI puts the effort in Gemini's model name. With no
// rule (opencode, which fronts many providers) the agent's default is used.
const RULES = {
  claude: { fast: [/^haiku$/], balanced: [/^sonnet$/], best: [/^opus$/] },
  codex: { fast: [/luna/], balanced: [/sol/], best: [/astra/] },
  gemini: {
    fast: [/^gemini.*flash.*low$/],
    balanced: [/^gemini.*flash.*medium$/],
    best: [/^gemini.*pro.*high$/, /^gemini.*pro/, /^gemini.*flash.*high$/],
  },
};

let state = { tier: DEFAULT_TIER, overrides: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

function save() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

export const isTier = (t) => TIERS.some((x) => x.value === t);
export const tier = () => (isTier(state.tier) ? state.tier : DEFAULT_TIER);

function effortsOf(options, model) {
  const m = options.models.find((x) => x.value === model) || options.models.find((x) => x.label === options.defaultModel);
  return m?.efforts || options.efforts.map((e) => e.value);
}

// What the tier itself picks for an agent, from its options (backend.options()).
export function tierPick(agent, options, t) {
  let model = null;
  for (const re of RULES[agent]?.[t] || []) {
    model = options.models.find((m) => re.test(m.value))?.value || null;
    if (model) break;
  }
  const effort = effortsOf(options, model).includes(EFFORT[t]) ? EFFORT[t] : null;
  return { model, effort };
}

// The { model, effort, custom } an agent uses in tier `t`; `custom` when
// picked by hand.
export function pick(agent, options, t) {
  const o = state.overrides[t]?.[agent];
  return o ? { model: o.model || null, effort: o.effort || null, custom: true } : { ...tierPick(agent, options, t), custom: false };
}

export function setTier(t) {
  if (state.tier === t) return;
  state.tier = t;
  save();
}

// A model picked by hand; picking what the tier would have drops the override.
export function setPick(agent, options, t, model, effort) {
  const auto = tierPick(agent, options, t);
  const by = (state.overrides[t] ||= {});
  if ((model || null) === auto.model && (effort || null) === auto.effort) delete by[agent];
  else by[agent] = { model: model || null, effort: effort || null };
  save();
}

// Back to the tier's own pick.
export function resetPick(agent, t) {
  if (!state.overrides[t]?.[agent]) return;
  delete state.overrides[t][agent];
  save();
}
