const tools = require('./tools');

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const ULTIMATE_PERFORMANCE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';

// Plan that was active before Game Mode was turned on; null while Game Mode is off.
let previousPlan = null;

function isActive() {
  return previousPlan !== null;
}

function getState() {
  return { active: isActive() };
}

async function enable() {
  if (isActive()) return getState();
  const plans = await tools.listPowerPlans();
  const current = plans.find((p) => p.active);
  const target =
    plans.find((p) => p.guid.toLowerCase() === ULTIMATE_PERFORMANCE) ||
    plans.find((p) => p.guid.toLowerCase() === HIGH_PERFORMANCE);

  if (target) await tools.setPowerPlan(target.guid);
  else await tools.enableUltimatePerformance();

  previousPlan = current?.guid ?? BALANCED;
  return getState();
}

async function disable() {
  if (!isActive()) return getState();
  const plan = previousPlan;
  previousPlan = null;
  await tools.setPowerPlan(plan);
  return getState();
}

async function setActive(enabled) {
  return enabled ? enable() : disable();
}

module.exports = { isActive, getState, setActive, disable };
