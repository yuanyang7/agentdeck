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

// Each agent's model for a tier, matched by price class so a tier compares
// like with like (per million tokens, October 2026):
//   Fast      Haiku 5.5 · GPT-6-Luna ($0.10/$0.50) · Gemini Flash-Lite
//   Balanced  Sonnet 5.5 · GPT-6.1-Sol · Gemini 4 Argon ($2/$10 each)
//   Best      Opus 5.5 · GPT-6-Astra · Gemini Argon at high effort
// `exact` patterns find the matched model; `closest` ones stand in when the
// login doesn't offer it (an older Claude Code whose `haiku` is still Haiku
// 4.5, a Gemini login without Argon), and the dialog says so. Patterns are
// tried in order against the model's id and the id it resolves to; lists put
// newer models first, so `sol` finds the latest Sol. Antigravity CLI puts the
// effort in Gemini's model name. With no rule (opencode, which fronts many
// providers) the agent's default is used.
const RULES = {
  claude: {
    fast: { exact: [/haiku-5/], closest: [/^haiku$/] },
    balanced: { exact: [/^sonnet$/] },
    best: { exact: [/^opus$/] },
  },
  codex: { fast: { exact: [/luna/] }, balanced: { exact: [/sol/] }, best: { exact: [/astra/] } },
  gemini: {
    fast: { exact: [/flash-?lite.*low$/, /flash-?lite/], closest: [/^gemini.*flash.*low$/] },
    balanced: { exact: [/argon.*medium$/, /argon/], closest: [/^gemini.*flash.*medium$/] },
    best: { exact: [/argon.*high$/, /argon/, /^gemini.*pro.*high$/, /^gemini.*pro/], closest: [/^gemini.*flash.*high$/] },
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

// What the tier itself picks for an agent, from its options
// (backend.options()). `closest` when no model of the tier's price class is
// offered and a stand-in was picked.
export function tierPick(agent, options, t) {
  const rule = RULES[agent]?.[t];
  const find = (res) => {
    for (const re of res || []) {
      const m = options.models.find((x) => re.test(x.value) || (x.resolved && re.test(x.resolved)));
      if (m) return m.value;
    }
    return null;
  };
  let model = find(rule?.exact);
  const closest = !model && !!rule;
  if (!model) model = find(rule?.closest);
  const effort = effortsOf(options, model).includes(EFFORT[t]) ? EFFORT[t] : null;
  return { model, effort, closest };
}

// The { model, effort, custom, closest } an agent uses in tier `t`; `custom`
// when picked by hand.
export function pick(agent, options, t) {
  const o = state.overrides[t]?.[agent];
  return o ? { model: o.model || null, effort: o.effort || null, custom: true, closest: false } : { ...tierPick(agent, options, t), custom: false };
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
