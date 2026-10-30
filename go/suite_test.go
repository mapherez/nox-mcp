package noxmcp

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSharedSuiteConformance(t *testing.T) {
	data, e := Contracts.ReadFile("contracts/suite-conformance.json")
	if e != nil {
		t.Fatal(e)
	}
	var corpus struct {
		SchemaCases []struct {
			ID, Schema string
			Data       json.RawMessage
			Error      string
		}
		Origins, Paths []struct{ Input, Expect, Error string }
		RawCases       []struct{ Input, Error string }
	}
	if e = json.Unmarshal(data, &corpus); e != nil {
		t.Fatal(e)
	}
	report := map[string]any{"documents": []any{}, "origins": []any{}, "paths": []any{}, "raw": []any{}}
	for _, example := range corpus.SchemaCases {
		t.Run(example.ID, func(t *testing.T) {
			value, e := LoadSuiteDocument(example.Schema, example.Data)
			var actual any = value
			if e != nil {
				actual = map[string]any{"error": e.Error()}
				if e.Error() != example.Error {
					t.Fatalf("got %v, expected %s", e, example.Error)
				}
			} else {
				if example.Error != "" {
					t.Fatalf("accepted, expected %s", example.Error)
				}
				var expected any
				json.Unmarshal(example.Data, &expected)
				if !reflect.DeepEqual(value, expected) {
					t.Fatal("loader changed document")
				}
			}
			report["documents"] = append(report["documents"].([]any), actual)
		})
	}
	for name, examples := range map[string][]struct{ Input, Expect, Error string }{"origins": corpus.Origins, "paths": corpus.Paths} {
		for _, example := range examples {
			var value string
			var e error
			if name == "origins" {
				value, e = NormalizeSuiteOrigin(example.Input)
			} else {
				value, e = NormalizeSuitePath(example.Input)
			}
			var actual any = value
			if e != nil {
				actual = map[string]any{"error": e.Error()}
				if e.Error() != example.Error {
					t.Fatalf("%s %q: %v, expected %s", name, example.Input, e, example.Error)
				}
			} else if value != example.Expect || example.Error != "" {
				t.Fatalf("%s %q: got %q", name, example.Input, value)
			}
			report[name] = append(report[name].([]any), actual)
		}
	}
	for _, example := range corpus.RawCases {
		_, e := ParseSuiteJSON([]byte(example.Input))
		if e == nil || e.Error() != example.Error {
			t.Fatalf("raw %q: %v", example.Input, e)
		}
		report["raw"] = append(report["raw"].([]any), map[string]any{"error": e.Error()})
	}
	var full JSON
	json.Unmarshal(data, &full)

	report["budgets"] = []any{}
	for _, raw := range array(full["budgetCases"]) {
		ex := object(raw)
		b, _ := json.Marshal(ex["controls"])
		var controls SuiteRequestControls
		json.Unmarshal(b, &controls)
		result, e := SuiteRequestBudget(controls, time.UnixMilli(int64(ex["nowMs"].(float64))), time.Duration(ex["localMaxMs"].(float64))*time.Millisecond, time.Duration(ex["clockUncertaintyMs"].(float64))*time.Millisecond)
		var actual any = result
		if e != nil {
			actual = JSON{"error": e.Error()}
		}
		b, _ = json.Marshal(actual)
		var normalized any
		json.Unmarshal(b, &normalized)
		expected := ex["expect"]
		if ex["error"] != nil {
			expected = JSON{"error": ex["error"]}
		}
		if !reflect.DeepEqual(expected, normalized) {
			t.Fatalf("budget %s: %#v", ex["id"], normalized)
		}
		report["budgets"] = append(report["budgets"].([]any), actual)
	}
	report["viewKeys"] = []any{}
	c := object(full["crypto"])
	for _, name := range []string{"valid-user", "valid-probe", "valid-other-user", "valid-renewed-authorization"} {
		for _, raw := range array(c["cases"]) {
			ex := object(raw)
			if ex["id"] == name {
				id, e := VerifySuiteToken(text(ex["token"]), suiteFixtureOptions(c))
				if e != nil {
					t.Fatal(e)
				}
				key, e := SuiteAuthorizationViewKey(id, text(object(c["pairing"])["partition"]), "1.0")
				if e != nil {
					t.Fatal(e)
				}
				report["viewKeys"] = append(report["viewKeys"].([]any), key)
			}
		}
	}
	runSuiteState(t, full, report)
	runSuiteCrypto(t, full, report)
	runSuiteGateway(t, full, report)
	if path := os.Getenv("NOX_SUITE_REPORT"); path != "" {
		encoded, _ := json.Marshal(report)
		if e = os.WriteFile(path, encoded, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
func runSuiteGateway(t *testing.T, corpus, report JSON) {
	report["gateway"] = []any{}
	for _, item := range array(corpus["gatewayCases"]) {
		example := object(item)
		encoded, _ := json.Marshal(example["input"])
		var options SuiteGatewayOptions
		if e := json.Unmarshal(encoded, &options); e != nil {
			t.Fatal(e)
		}
		snapshot, e := ComposeSuiteGateway(options)
		var actual any = snapshot
		if expected := text(example["error"]); expected != "" {
			if e == nil || e.Error() != expected {
				t.Fatalf("gateway %s: %v, expected %s", example["id"], e, expected)
			}
			actual = JSON{"error": e.Error()}
		} else {
			if e != nil {
				t.Fatalf("gateway %s: %v", example["id"], e)
			}
			if snapshot.ContractVersion != "1.0" {
				t.Fatal("snapshot version")
			}
			for _, route := range snapshot.Routes {
				if len(route.Alias) > 64 {
					t.Fatal("long alias")
				}
				if route.Availability == "available" {
					got, e := SelectSuiteRoute(snapshot, route.Alias, route.Fingerprint)
					if e != nil || got.ToolName != route.ToolName {
						t.Fatal("route mismatch")
					}
					if _, e = SelectSuiteRoute(snapshot, route.Alias, strings.Repeat("A", 43)); e == nil {
						t.Fatal("stale route accepted")
					}
				} else {
					if _, e = SelectSuiteRoute(snapshot, route.Alias, ""); e == nil {
						t.Fatal("unavailable route accepted")
					}
				}
			}
		}
		report["gateway"] = append(report["gateway"].([]any), actual)
	}
}

func suiteFixtureOptions(c JSON) SuiteVerificationOptions {
	var key SuiteSigningKey
	encoded, _ := json.Marshal(c["publicKey"])
	json.Unmarshal(encoded, &key)
	opts := object(c["options"])
	return SuiteVerificationOptions{Issuer: text(opts["issuer"]), Audience: text(opts["audience"]), ProductID: text(opts["productId"]), AssociationID: text(opts["associationId"]), GatewayServiceID: text(opts["gatewayServiceId"]), RegistrationRevision: text(opts["registrationRevision"]), ServiceCredentialRevision: text(opts["serviceCredentialRevision"]), Keys: map[string]SuiteSigningKey{*key.Kid: key}, Now: time.UnixMilli(int64(opts["nowMs"].(float64)))}
}
func runSuiteCrypto(t *testing.T, corpus, report JSON) {
	c := object(corpus["crypto"])
	report["crypto"] = []any{}
	for _, item := range array(c["cases"]) {
		example := object(item)
		options := suiteFixtureOptions(c)
		overrides := object(example["options"])
		if now, ok := overrides["nowMs"]; ok {
			options.Now = time.UnixMilli(int64(now.(float64)))
		}
		options.Kind = text(overrides["kind"])
		key := options.Keys["fixture-es256"]
		switch example["keyVariant"] {
		case "private":
			key.Extra = map[string]json.RawMessage{"d": json.RawMessage(`"` + strings.Repeat("A", 43) + `"`)}
		case "point":
			key.Y = strings.Repeat("A", 43)
		case "purpose":
			purpose := "enc"
			key.Use = &purpose
		}
		options.Keys["fixture-es256"] = key
		identity, e := VerifySuiteToken(text(example["token"]), options)
		var actual any
		if e != nil {
			actual = JSON{"error": e.Error()}
		} else {
			actual = JSON{"kind": identity.Kind(), "context": identity.Context(), "expiresAtMs": identity.ExpiresAt().UnixMilli()}
		}
		if !reflect.DeepEqual(jsonObject(actual), example["expect"]) {
			t.Fatalf("crypto %s: got %v, expected %v", example["id"], actual, example["expect"])
		}
		report["crypto"] = append(report["crypto"].([]any), actual)
	}
	report["methods"] = []any{}
	for _, item := range array(c["methods"]) {
		example := object(item)
		options := suiteFixtureOptions(c)
		identity, e := VerifySuiteToken(text(c[text(example["kind"])+"Token"]), options)
		if e != nil {
			t.Fatal(e)
		}
		e = RequireSuiteMethod(identity, text(example["method"]), options.Now)
		var actual any = true
		if e != nil {
			actual = JSON{"error": e.Error()}
		}
		if expected := text(example["error"]); expected != "" {
			if e == nil || e.Error() != expected {
				t.Fatalf("method guard: %v", e)
			}
		} else if e != nil {
			t.Fatal(e)
		}
		report["methods"] = append(report["methods"].([]any), actual)
	}
	pair := object(c["pairing"])
	secret, e := base64.RawURLEncoding.DecodeString(text(pair["secret"]))
	if e != nil {
		t.Fatal(e)
	}
	bindingJSON, _ := json.Marshal(pair["binding"])
	binding, e := LoadSuitePairingBinding(bindingJSON)
	if e != nil {
		t.Fatal(e)
	}
	proof, e := CreateSuitePairingProof(secret, binding)
	if e != nil || proof != text(pair["proof"]) {
		t.Fatalf("proof %q %v", proof, e)
	}
	if !VerifySuitePairingProof(secret, binding, proof) {
		t.Fatal("proof verification")
	}
	binding.ProductID = "different"
	if VerifySuitePairingProof(secret, binding, proof) {
		t.Fatal("proof accepted different product")
	}
	partition, e := SuiteCredentialPartition("fictional-api-key", secret)
	if e != nil || partition != text(pair["partition"]) {
		t.Fatal("partition mismatch")
	}
	report["pairing"] = JSON{"proof": proof, "partition": partition}
	report["aliases"] = []any{}
	for _, item := range array(corpus["aliases"]) {
		example := object(item)
		alias, e := SuiteToolAlias(text(example["productId"]), text(example["toolName"]))
		if e != nil || alias != text(example["expect"]) {
			t.Fatalf("alias %q: %v", alias, e)
		}
		report["aliases"] = append(report["aliases"].([]any), alias)
	}
}

func TestSuiteVerifiedIdentityCannotBeForgedOrMutated(t *testing.T) {
	if e := RequireSuiteMethod(&VerifiedSuiteIdentity{}, "tools/call", time.Now()); e == nil {
		t.Fatal("zero value identity accepted")
	}
	data, _ := Contracts.ReadFile("contracts/suite-conformance.json")
	var corpus JSON
	json.Unmarshal(data, &corpus)
	c := object(corpus["crypto"])
	identity, e := VerifySuiteToken(text(c["userToken"]), suiteFixtureOptions(c))
	if e != nil {
		t.Fatal(e)
	}
	context := identity.Context()
	context["scopes"] = []string{"nox:write"}
	if text(identity.Context()["userId"]) != "user-1" || len(array(identity.Context()["scopes"])) != 1 || text(array(identity.Context()["scopes"])[0]) != "nox:inspect" {
		t.Fatal("context mutated")
	}
	encoded, _ := json.Marshal(identity)
	if strings.Contains(string(encoded), identity.AccessToken()) || strings.Contains(fmt.Sprintf("%#v", identity), identity.AccessToken()) {
		t.Fatal("token leaked in diagnostic output")
	}
	if e = RequireSuiteMethod(identity, "tools/call", identity.ExpiresAt()); e == nil {
		t.Fatal("expired identity accepted")
	}
}
func TestSuiteTypedDocumentsPreserveExtensions(t *testing.T) {
	data := []byte(`{"contractVersion":"1.0","productId":"example-project","productVersion":"1","displayName":"Example","capabilities":{"suiteMcp":{"path":"/mcp","custom":false},"unknown":{"present":null}},"custom":[null,false,{}]}`)
	value, e := LoadSuiteProductDeclaration(data)
	if e != nil {
		t.Fatal(e)
	}
	encoded, e := json.Marshal(value)
	if e != nil {
		t.Fatal(e)
	}
	var before, after any
	json.Unmarshal(data, &before)
	json.Unmarshal(encoded, &after)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("DTO lost extensions: %s", encoded)
	}
}

func runSuiteState(t *testing.T, corpus, report JSON) {
	report["observations"] = []any{}
	for _, raw := range array(corpus["observationCases"]) {
		ex := object(raw)
		b, _ := json.Marshal(ex["binding"])
		var binding SuiteObservationBinding
		json.Unmarshal(b, &binding)
		b, _ = json.Marshal(ex["input"])
		var previous *SuiteObservationEnvelope
		if ex["previous"] != nil {
			p, _ := json.Marshal(ex["previous"])
			v, e := LoadSuiteObservationEnvelope(p)
			if e != nil {
				t.Fatal(e)
			}
			previous = &v
		}
		result, e := AcceptSuiteObservation(binding, b, time.UnixMilli(int64(ex["receivedAtMs"].(float64))), previous, SuiteObservationFreshnessMS*time.Millisecond)
		var actual any = result
		if e != nil {
			actual = JSON{"error": e.Error()}
		}
		if expected := text(ex["error"]); expected != "" && (e == nil || e.Error() != expected) {
			t.Fatalf("observation %s: %v", ex["id"], e)
		}
		report["observations"] = append(report["observations"].([]any), actual)
	}
	report["registry"] = []any{}
	for _, raw := range array(corpus["registryCases"]) {
		ex := object(raw)
		b, _ := json.Marshal(ex["snapshot"])
		input, e := LoadSuiteRegistrySnapshot(b)
		if e != nil {
			t.Fatal(e)
		}
		b, _ = json.Marshal(ex["page"])
		result, e := ReduceSuiteRegistry(input, b, text(ex["expectedCursor"]))
		var actual any = result
		if e != nil {
			actual = JSON{"error": e.Error()}
		}
		if expected := text(ex["error"]); expected != "" && (e == nil || e.Error() != expected) {
			t.Fatalf("registry %s: %v", ex["id"], e)
		}
		report["registry"] = append(report["registry"].([]any), actual)
	}
}

func TestSuiteTypedGatewayPreservesAuthorizationMetadata(t *testing.T) {
	data, _ := Contracts.ReadFile("contracts/suite-conformance.json")
	var corpus JSON
	json.Unmarshal(data, &corpus)
	input := object(array(corpus["gatewayCases"])[0])["input"]
	source := array(object(input)["sources"])[0]
	encoded, _ := json.Marshal(source)
	typed, e := LoadSuiteGatewaySource(encoded)
	if e != nil {
		t.Fatal(e)
	}
	output, _ := json.Marshal(typed)
	var actual any
	json.Unmarshal(output, &actual)
	if !reflect.DeepEqual(source, actual) {
		t.Fatal("typed source changed metadata or field presence")
	}
}
