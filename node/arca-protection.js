export function createArcaProtection({ policy, now = () => performance.now(), onTransition = () => {} }) {
  let state = policy.circuitEnabled ? 'closed' : 'disabled';
  let epoch = 0;
  let openedUntil = 0;
  let active = 0;
  let probeInFlight = false;
  let results = [];
  const permits = new WeakSet();

  function snapshot() {
    return { state, active, limit: policy.maxConcurrent,
      retryAfterSeconds: state === 'open' ? Math.max(1, Math.ceil((openedUntil - now()) / 1000)) : 1 };
  }

  function transition(next) {
    const previous = state;
    state = next;
    epoch += 1;
    probeInFlight = false;
    if (next === 'open') openedUntil = now() + policy.circuitOpenMs;
    if (next === 'closed') results = [];
    onTransition({ previous, state: next });
  }

  function enter() {
    if (state === 'open' && now() >= openedUntil) transition('half_open');
    if (state === 'open' || (state === 'half_open' && probeInFlight)) {
      return { allowed: false, reason: 'circuit_open', ...snapshot() };
    }
    if (policy.maxConcurrent > 0 && active >= policy.maxConcurrent) {
      return { allowed: false, reason: 'concurrency_limit', ...snapshot() };
    }
    const permit = { epoch, probe: state === 'half_open' };
    permits.add(permit);
    active += 1;
    if (permit.probe) probeInFlight = true;
    return { allowed: true, permit };
  }

  function canCall(permit) {
    return permits.has(permit) && permit.epoch === epoch
      && (state === 'disabled' || state === 'closed' || (state === 'half_open' && permit.probe));
  }

  function leave(permit, health = 'ignore') {
    if (!permits.has(permit)) return;
    permits.delete(permit);
    active -= 1;
    // Una respuesta vieja no puede cerrar un circuito abierto por otras operaciones.
    if (permit.epoch !== epoch || state === 'disabled') return;
    if (permit.probe) {
      probeInFlight = false;
      if (health === 'success') transition('closed');
      else if (health === 'failure') transition('open');
      return;
    }
    if (state !== 'closed' || health === 'ignore') return;
    results.push(health === 'failure');
    if (results.length > policy.circuitMinSamples) results.shift();
    if (results.length === policy.circuitMinSamples
        && results.filter(Boolean).length / results.length >= policy.circuitFailureRatio) {
      transition('open');
    }
  }

  return { enter, canCall, leave, snapshot };
}
