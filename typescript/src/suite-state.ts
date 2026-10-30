import { canonicalize } from './discovery.js';
import { compareSuiteSequences, loadSuiteDocument, parseSuiteTimestamp, suiteDefaults, suiteFail } from './suite.js';
import type { SuiteObservation, SuiteObservationEnvelope, SuiteRegistrySnapshot } from './suite-types.generated.js';

export interface SuiteObservationBinding {
  productId: string; registrationRevision: string; associationId: string;
  source: 'yard' | 'gateway'; producerId: string; producerEpoch: string;
  managedBy?: { productId: string; deploymentId: string };
}
export function acceptSuiteObservation(binding: SuiteObservationBinding, input: unknown, receivedAtMs: number, previous?: SuiteObservationEnvelope, freshnessMs: number = suiteDefaults.observationFreshnessMs): { accepted: boolean; envelope: SuiteObservationEnvelope } {
  const observation = loadSuiteDocument('observation', input);
  if (!Number.isSafeInteger(receivedAtMs) || !Number.isSafeInteger(freshnessMs) || freshnessMs <= 0) suiteFail('INVALID_OBSERVATION');
  for (const key of ['productId', 'registrationRevision', 'associationId', 'source', 'producerId', 'producerEpoch'] as const) if (observation[key] !== binding[key]) suiteFail('STALE_OBSERVATION');
  if (observation.source === 'yard' && (!binding.managedBy || observation.managedBy?.productId !== binding.managedBy.productId || observation.managedBy?.deploymentId !== binding.managedBy.deploymentId)) suiteFail('STALE_OBSERVATION');
  const observedAt = parseSuiteTimestamp(observation.observedAt);
  if (observedAt > receivedAtMs + suiteDefaults.clockSafetyMs) suiteFail('INVALID_OBSERVATION');
  if (previous) {
    const checked = loadSuiteDocument('observation-envelope', previous); const old = checked.observation;
    if (['productId', 'registrationRevision', 'associationId', 'source', 'producerId', 'producerEpoch'].every(key => old[key] === observation[key])) {
      const order = compareSuiteSequences(observation.sequence, old.sequence);
      if (order === 0 && canonicalize(observation) !== canonicalize(old)) suiteFail('OBSERVATION_CONFLICT');
      if (order <= 0) return { accepted: false, envelope: checked };
    }
  }
  return { accepted: true, envelope: loadSuiteDocument('observation-envelope', { observation, receivedAt: new Date(receivedAtMs).toISOString(), freshUntil: new Date(Math.min(receivedAtMs, observedAt) + freshnessMs).toISOString() }) };
}
export function suiteObservationState(input: SuiteObservationEnvelope, nowMs: number): string {
  const envelope = loadSuiteDocument('observation-envelope', input);
  return nowMs >= parseSuiteTimestamp(envelope.freshUntil) ? 'unknown' : envelope.observation.state;
}

/** Pure atomic reduction: commit the returned snapshot and authorization invalidations under the host's admission lock. */
export function reduceSuiteRegistry(input: SuiteRegistrySnapshot, pageInput: unknown, expectedCursor: string): SuiteRegistrySnapshot {
  const snapshot = loadSuiteDocument('registry-snapshot', input), page = loadSuiteDocument('event-page', pageInput);
  if (page.cursor === snapshot.cursor && expectedCursor !== snapshot.cursor) return snapshot;
  if (snapshot.cursor !== expectedCursor) suiteFail('STALE_EVENT_CURSOR');
  if (page.cursor === snapshot.cursor && page.events.length) suiteFail('STALE_EVENT_CURSOR');
  const products = new Map(snapshot.products.map(product => [product.productId, product]));
  let observations = snapshot.observations;
  for (const event of page.events as any[]) {
    const data = event.data;
    switch (event.type) {
      case 'product.upserted': {
        const product = data.record;
        products.set(product.productId, product); snapshot.registryRevision = data.registryRevision;
        observations = observations.filter(envelope => envelope.observation.productId !== product.productId || envelope.observation.associationId === product.associationId && envelope.observation.registrationRevision === product.revision);
        break;
      }
      case 'product.removed': {
        const product = products.get(data.productId);
        if (product && product.revision === data.retiredRevision && product.associationId === data.associationId) {
          products.delete(data.productId); observations = observations.filter(envelope => envelope.observation.productId !== data.productId || envelope.observation.associationId !== data.associationId);
        }
        snapshot.registryRevision = data.registryRevision; break;
      }
      case 'observation.updated': {
        const observation = data.observation as SuiteObservation; const product = products.get(observation.productId);
        if (!product || observation.associationId !== product.associationId || observation.registrationRevision !== product.revision) break;
        observations = observations.filter(envelope => !['productId', 'associationId', 'source', 'producerId'].every(key => envelope.observation[key] === observation[key]));
        observations.push(loadSuiteDocument('observation-envelope', data)); break;
      }
      case 'producer.reassociated':
        observations = observations.filter(envelope => !['productId', 'associationId', 'source', 'producerId'].every(key => envelope.observation[key] === data[key])); break;
    }
  }
  snapshot.products = [...products.values()].sort((a, b) => a.productId < b.productId ? -1 : 1);
  snapshot.observations = observations.sort((a, b) => canonicalize([a.observation.productId, a.observation.source, a.observation.producerId, a.observation.producerEpoch]) < canonicalize([b.observation.productId, b.observation.source, b.observation.producerId, b.observation.producerEpoch]) ? -1 : 1);
  snapshot.cursor = page.cursor; return snapshot;
}

export interface SuiteRequestControls { requestId: string; deadlineAt: string; timeoutMs: number }
export function suiteRequestBudget(controls: SuiteRequestControls, nowMs: number, localMaxMs: number, clockUncertaintyMs: number = suiteDefaults.clockSafetyMs): SuiteRequestControls {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(controls.requestId) || ![nowMs, localMaxMs, controls.timeoutMs, clockUncertaintyMs].every(Number.isSafeInteger) || nowMs < 0 || localMaxMs <= 0 || controls.timeoutMs <= 0 || clockUncertaintyMs < 0 || clockUncertaintyMs > suiteDefaults.clockSafetyMs) suiteFail('INVALID_REQUEST_CONTROLS');
  const remaining = Math.min(controls.timeoutMs, parseSuiteTimestamp(controls.deadlineAt) - nowMs - clockUncertaintyMs, localMaxMs);
  if (remaining <= 0) suiteFail('TIMEOUT');
  return { requestId: controls.requestId, timeoutMs: remaining, deadlineAt: new Date(nowMs + remaining).toISOString() };
}
