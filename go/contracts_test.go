package noxmcp

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
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
			Data       json.RawMessage
		} `json:"cases"`
		SchemaCases []struct {
			ID     string
			Schema jsonschema.Schema
			Data   any
			Valid  bool
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
		})
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
			resolved, err := example.Schema.Resolve(nil)
			if err != nil {
				t.Fatal(err)
			}
			if got := resolved.Validate(example.Data) == nil; got != example.Valid {
				t.Fatalf("valid=%v, want %v", got, example.Valid)
			}
		})
	}
}
