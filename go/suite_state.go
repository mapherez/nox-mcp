package noxmcp

import (
	"encoding/json"
	"regexp"
	"sort"
	"time"
)

// SuiteObservationBinding is established by the registry, never by the producer payload.
type SuiteObservationBinding struct {
	ProductID, RegistrationRevision, AssociationID, Source, ProducerID, ProducerEpoch string
	ManagedBy                                                                         *SuiteRegistrationRecordManagedBy
}
type SuiteAcceptedObservation struct {
	Accepted bool                     `json:"accepted"`
	Envelope SuiteObservationEnvelope `json:"envelope"`
}

func suiteDTOObject(v any) (JSON, error) {
	b, e := json.Marshal(v)
	if e != nil {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	var out JSON
	e = json.Unmarshal(b, &out)
	return out, e
}
func suiteSameFields(a, b JSON, keys ...string) bool {
	for _, k := range keys {
		if a[k] != b[k] {
			return false
		}
	}
	return true
}
func AcceptSuiteObservation(binding SuiteObservationBinding, input []byte, receivedAt time.Time, previous *SuiteObservationEnvelope, freshness time.Duration) (SuiteAcceptedObservation, error) {
	var result SuiteAcceptedObservation
	observation, e := LoadSuiteObservation(input)
	if e != nil {
		return result, e
	}
	if freshness <= 0 || freshness%time.Millisecond != 0 || receivedAt.UnixMilli() < 0 {
		return result, suiteFailure("INVALID_OBSERVATION")
	}
	if observation.ProductID != binding.ProductID || observation.RegistrationRevision != binding.RegistrationRevision || observation.AssociationID != binding.AssociationID || observation.Source != binding.Source || observation.ProducerID != binding.ProducerID || observation.ProducerEpoch != binding.ProducerEpoch {
		return result, suiteFailure("STALE_OBSERVATION")
	}
	if observation.Source == "yard" && (observation.ManagedBy == nil || binding.ManagedBy == nil || observation.ManagedBy.ProductID != binding.ManagedBy.ProductID || observation.ManagedBy.DeploymentID != binding.ManagedBy.DeploymentID) {
		return result, suiteFailure("STALE_OBSERVATION")
	}
	observedAt, _ := ParseSuiteTimestamp(observation.ObservedAt)
	if observedAt.After(receivedAt.Add(SuiteClockSafetyMS * time.Millisecond)) {
		return result, suiteFailure("INVALID_OBSERVATION")
	}
	if previous != nil {
		b, e := json.Marshal(previous)
		if e != nil {
			return result, e
		}
		checked, e := LoadSuiteObservationEnvelope(b)
		if e != nil {
			return result, e
		}
		old := checked.Observation
		if old.ProductID == observation.ProductID && old.RegistrationRevision == observation.RegistrationRevision && old.AssociationID == observation.AssociationID && old.Source == observation.Source && old.ProducerID == observation.ProducerID && old.ProducerEpoch == observation.ProducerEpoch {
			order, _ := CompareSuiteSequences(observation.Sequence, old.Sequence)
			a, _ := suiteDTOObject(observation)
			b, _ := suiteDTOObject(old)
			ca, _ := Canonicalize(a)
			cb, _ := Canonicalize(b)
			if order == 0 && ca != cb {
				return result, suiteFailure("OBSERVATION_CONFLICT")
			}
			if order <= 0 {
				return SuiteAcceptedObservation{false, checked}, nil
			}
		}
	}
	if receivedAt.Before(observedAt) {
		observedAt = receivedAt
	}
	format := "2006-01-02T15:04:05.000Z"
	envelope := SuiteObservationEnvelope{Observation: observation, ReceivedAt: receivedAt.UTC().Format(format), FreshUntil: observedAt.Add(freshness).UTC().Format(format)}
	b, _ := json.Marshal(envelope)
	envelope, e = LoadSuiteObservationEnvelope(b)
	return SuiteAcceptedObservation{true, envelope}, e
}
func SuiteObservationState(envelope SuiteObservationEnvelope, now time.Time) (string, error) {
	b, _ := json.Marshal(envelope)
	checked, e := LoadSuiteObservationEnvelope(b)
	if e != nil {
		return "", e
	}
	until, _ := ParseSuiteTimestamp(checked.FreshUntil)
	if !now.Before(until) {
		return "unknown", nil
	}
	return checked.Observation.State, nil
}

// ReduceSuiteRegistry returns a new snapshot. The host atomically commits it with authorization invalidations.
func ReduceSuiteRegistry(input SuiteRegistrySnapshot, pageInput []byte, expectedCursor string) (SuiteRegistrySnapshot, error) {
	b, _ := json.Marshal(input)
	snapshot, e := LoadSuiteRegistrySnapshot(b)
	if e != nil {
		return snapshot, e
	}
	page, e := LoadSuiteDocument("event-page", pageInput)
	if e != nil {
		return snapshot, e
	}
	cursor := text(page["cursor"])
	if cursor == snapshot.Cursor && expectedCursor != snapshot.Cursor {
		return snapshot, nil
	}
	if snapshot.Cursor != expectedCursor || cursor == snapshot.Cursor && len(array(page["events"])) > 0 {
		return snapshot, suiteFailure("STALE_EVENT_CURSOR")
	}
	products := map[string]SuiteRegistrationRecord{}
	for _, p := range snapshot.Products {
		products[p.ProductID] = p
	}
	observations := snapshot.Observations
	filter := func(keep func(SuiteObservation) bool) {
		out := []SuiteObservationEnvelope{}
		for _, envelope := range observations {
			if keep(envelope.Observation) {
				out = append(out, envelope)
			}
		}
		observations = out
	}
	for _, raw := range array(page["events"]) {
		event := object(raw)
		data := object(event["data"])
		switch event["type"] {
		case "product.upserted":
			b, _ := json.Marshal(data["record"])
			p, _ := LoadSuiteRegistrationRecord(b)
			products[p.ProductID] = p
			snapshot.RegistryRevision = text(data["registryRevision"])
			filter(func(o SuiteObservation) bool {
				return o.ProductID != p.ProductID || o.AssociationID == p.AssociationID && o.RegistrationRevision == p.Revision
			})
		case "product.removed":
			p, ok := products[text(data["productId"])]
			if ok && p.Revision == data["retiredRevision"] && p.AssociationID == data["associationId"] {
				delete(products, p.ProductID)
				filter(func(o SuiteObservation) bool { return o.ProductID != p.ProductID || o.AssociationID != p.AssociationID })
			}
			snapshot.RegistryRevision = text(data["registryRevision"])
		case "observation.updated":
			b, _ := json.Marshal(data)
			envelope, _ := LoadSuiteObservationEnvelope(b)
			o := envelope.Observation
			p, ok := products[o.ProductID]
			if !ok || o.AssociationID != p.AssociationID || o.RegistrationRevision != p.Revision {
				continue
			}
			filter(func(old SuiteObservation) bool {
				return old.ProductID != o.ProductID || old.AssociationID != o.AssociationID || old.Source != o.Source || old.ProducerID != o.ProducerID
			})
			observations = append(observations, envelope)
		case "producer.reassociated":
			filter(func(o SuiteObservation) bool {
				return o.ProductID != data["productId"] || o.AssociationID != data["associationId"] || o.Source != data["source"] || o.ProducerID != data["producerId"]
			})
		}
	}
	snapshot.Products = []SuiteRegistrationRecord{}
	for _, p := range products {
		snapshot.Products = append(snapshot.Products, p)
	}
	sort.Slice(snapshot.Products, func(i, j int) bool { return snapshot.Products[i].ProductID < snapshot.Products[j].ProductID })
	sort.Slice(observations, func(i, j int) bool {
		a, b := observations[i].Observation, observations[j].Observation
		ca, _ := Canonicalize([]any{a.ProductID, a.Source, a.ProducerID, a.ProducerEpoch})
		cb, _ := Canonicalize([]any{b.ProductID, b.Source, b.ProducerID, b.ProducerEpoch})
		return utf16Less(ca, cb)
	})
	snapshot.Observations = observations
	snapshot.Cursor = cursor
	return snapshot, nil
}

type SuiteRequestControls struct {
	RequestID  string `json:"requestId"`
	DeadlineAt string `json:"deadlineAt"`
	TimeoutMS  int64  `json:"timeoutMs"`
}

func SuiteRequestBudget(controls SuiteRequestControls, now time.Time, localMax, uncertainty time.Duration) (SuiteRequestControls, error) {
	if !regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(controls.RequestID) || controls.TimeoutMS <= 0 || localMax <= 0 || uncertainty < 0 || uncertainty > SuiteClockSafetyMS*time.Millisecond || now.UnixMilli() < 0 {
		return controls, suiteFailure("INVALID_REQUEST_CONTROLS")
	}
	deadline, e := ParseSuiteTimestamp(controls.DeadlineAt)
	if e != nil {
		return controls, e
	}
	remaining := min(controls.TimeoutMS, deadline.UnixMilli()-now.UnixMilli()-uncertainty.Milliseconds(), localMax.Milliseconds())
	if remaining <= 0 {
		return controls, suiteFailure("TIMEOUT")
	}
	controls.TimeoutMS = remaining
	controls.DeadlineAt = now.Add(time.Duration(remaining) * time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
	return controls, nil
}
