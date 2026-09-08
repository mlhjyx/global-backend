package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestCommandFailureNeverPrintsRenderedConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "malformed.yaml")
	if err := os.WriteFile(path, []byte("[DO_NOT_EMIT_CONFIG_SECRET"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TEMPORAL_SERVER_CONFIG_FILE_PATH", path)
	for _, args := range [][]string{nil, {"--allow-no-auth", "start"}, {"render-config"}, {"start"}} {
		var output bytes.Buffer
		if code := Command(args, &output); code != 1 {
			t.Fatal("invalid bootstrap accepted")
		}
		if output.String() != "TEMPORAL_PLATFORM_START_UNAVAILABLE\n" {
			t.Fatal("unbounded startup error")
		}
	}
	t.Setenv("TEMPORAL_SERVER_CONFIG_FILE_PATH", "")
	var output bytes.Buffer
	if Command([]string{"start"}, &output) != 1 {
		t.Fatal("missing config accepted")
	}
}
