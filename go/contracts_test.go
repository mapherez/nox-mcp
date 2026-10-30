package noxmcp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSharedContractConformance(t *testing.T) {
	data, err := Contracts.ReadFile("contracts/conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Version int `json:"version"`
		Cases   []struct {
			ID, Schema string
			Valid      bool
			Executable bool
			Data       json.RawMessage
		} `json:"cases"`
		SchemaCases []struct {
			ID          string
			Schema      any
			Data        any
			Valid       bool
			SchemaValid bool
		} `json:"schemaCases"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 {
		t.Fatal("unsupported corpus version")
	}
	covered := map[string]bool{}
	for _, example := range corpus.Cases {
		t.Run(example.ID, func(t *testing.T) {
			covered[example.Schema] = true
			before := string(example.Data)
			err := ValidateFrame(example.Schema, example.Data)
			if (err == nil) != example.Valid {
				t.Fatalf("valid=%v, want %v: %v", err == nil, example.Valid, err)
			}
			if string(example.Data) != before {
				t.Fatal("validator mutated the input")
			}
			if example.Schema == "manifest" {
				loaded, err := LoadToolManifest(example.Data)
				if (err == nil) != example.Executable {
					t.Fatalf("executable=%v, want %v: %v", err == nil, example.Executable, err)
				}
				if err == nil {
					var expected, actual any
					json.Unmarshal(example.Data, &expected)
					data, _ := json.Marshal(loaded)
					json.Unmarshal(data, &actual)
					if !reflect.DeepEqual(expected, actual) {
						t.Fatal("manifest changed during loading")
					}
				}
			}
		})
	}
	additionalData, err := Contracts.ReadFile("contracts/discovery-conformance.json")
	if err != nil {
		t.Fatal(err)
	}
	var additional struct {
		SchemaCases []struct {
			Schema string
			Data   json.RawMessage
			Valid  bool
		}
	}
	if err = json.Unmarshal(additionalData, &additional); err != nil {
		t.Fatal(err)
	}
	for _, example := range additional.SchemaCases {
		covered[example.Schema] = true
		if (ValidateFrame(example.Schema, example.Data) == nil) != example.Valid {
			t.Fatalf("discovery schema: %s", example.Schema)
		}
	}

	suiteData, e := Contracts.ReadFile("contracts/suite-conformance.json")
	if e != nil {
		t.Fatal(e)
	}
	var suiteCases struct {
		SchemaCases []struct {
			Schema string
			Data   json.RawMessage
			Error  string
		}
	}
	if e = json.Unmarshal(suiteData, &suiteCases); e != nil {
		t.Fatal(e)
	}
	for _, example := range suiteCases.SchemaCases {
		covered["suite-"+example.Schema] = true
		if _, e = LoadSuiteDocument(example.Schema, example.Data); (e == nil) != (example.Error == "") {
			t.Fatalf("suite schema: %s: %v", example.Schema, e)
		}
	}
	files, err := Contracts.ReadDir("contracts")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		const suffix = ".schema.json"
		name := file.Name()
		if len(name) > len(suffix) && name[len(name)-len(suffix):] == suffix && !covered[name[:len(name)-len(suffix)]] {
			t.Errorf("contract without shared examples: %s", name)
		}
	}
	for _, example := range corpus.SchemaCases {
		t.Run(example.ID, func(t *testing.T) {
			before, _ := json.Marshal([]any{example.Schema, example.Data})
			_, err := CompileToolSchema(example.Schema)
			if (err == nil) != example.SchemaValid {
				t.Fatalf("schemaValid=%v, want %v: %v", err == nil, example.SchemaValid, err)
			}
			if got := ValidateToolValue(example.Schema, example.Data); got != example.Valid {
				t.Fatalf("valid=%v, want %v", got, example.Valid)
			}
			after, _ := json.Marshal([]any{example.Schema, example.Data})
			if string(before) != string(after) {
				t.Fatal("schema or input mutated")
			}
		})
	}
}
