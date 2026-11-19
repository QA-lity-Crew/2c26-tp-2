export function createArcaProtection({ policy, now = () => performance.now(), onTransition = () => {} }) {
  let state = policy.circuitEnabled ? 'closed' : 'disabled';
  let epoch = 0;
  let openedUntil = 0;
  let active = 0;
  let probeInFlight = false;
  let results = [];
  const permits = new WeakSet();
  // FIFO acotada por proceso; los waiters no guardan DNI ni respuestas de ARCA.
  const waiters = new Set();
  const maxQueued = policy.maxQueued ?? 1000;
  const maxQueueWaitMs = policy.maxQueueWaitMs ?? 1000;

  function snapshot() {
    return { state, active, limit: policy.maxConcurrent,
      queued: waiters.size, queueLimit: maxQueued, queueWaitLimitMs: maxQueueWaitMs,
      retryAfterSeconds: state === 'open' ? Math.max(1, Math.ceil((openedUntil - now()) / 1000)) : 1 };
  }

  function finishWaiting(waiter, admission) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve({ ...admission, queued: true,
      queueWaitMs: Math.max(0, now() - waiter.started) });
  }

  function rejectWaiting(reason) {
    for (const waiter of waiters) {
      finishWaiting(waiter, { allowed: false, reason, ...snapshot() });
    }
  }

  function transition(next) {
    const previous = state;
    state = next;
    epoch += 1;
    probeInFlight = false;
    if (next === 'open') openedUntil = now() + policy.circuitOpenMs;
    if (next === 'closed') results = [];
    // No despachar al externo solicitudes que esperaban cuando abrio el CB.
    if (next === 'open') rejectWaiting('circuit_open');
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

  function drainQueue() {
    while (waiters.size > 0) {
      const waiter = waiters.values().next().value;
      // Comprobar tambien al liberar cupo: el event loop puede demorar un timer.
      if (now() - waiter.started >= maxQueueWaitMs) {
        finishWaiting(waiter, { allowed: false, reason: 'queue_timeout', ...snapshot() });
        continue;
      }
      const admission = enter();
      if (!admission.allowed) {
        if (admission.reason === 'circuit_open') rejectWaiting('circuit_open');
        return;
      }
      finishWaiting(waiter, admission);
    }
  }

  function acquire() {
    drainQueue();
    const admission = enter();
    if (admission.allowed || admission.reason !== 'concurrency_limit') {
      return Promise.resolve({ ...admission, queued: false, queueWaitMs: 0 });
    }
    if (waiters.size >= maxQueued || maxQueueWaitMs <= 0) {
      return Promise.resolve({ allowed: false, reason: 'queue_full',
        ...snapshot(), queued: false, queueWaitMs: 0 });
    }
    return new Promise(resolve => {
      const waiter = { resolve, started: now(), timer: null };
      waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        finishWaiting(waiter, { allowed: false, reason: 'queue_timeout', ...snapshot() });
      }, maxQueueWaitMs);
    });
  }

  function leave(permit, health = 'ignore') {
    if (!permits.has(permit)) return;
    permits.delete(permit);
    active -= 1;
    try {
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
    } finally {
      drainQueue();
    }
  }

  return { enter, acquire, canCall, leave, snapshot };
}
