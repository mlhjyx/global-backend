package main

import (
	"go.temporal.io/server/common/config"
	"strings"
	"testing"
)

func TestReaderEndpointAdmission(t *testing.T) {
	validate := ValidateReaderEndpoint
	makeConfig := func(name string) *config.Config {
		c := secureConfiguration()
		c.Global.TLS.Frontend.Client.ServerName = "public.example"
		c.Global.TLS.Frontend.PerHostOverrides = map[string]config.ServerTLS{name: c.Global.TLS.Frontend.Server}
		return c
	}
	for _, name := range []string{"reader.example", "localhost", strings.Repeat("a", 63) + ".example"} {
		if e := validate(makeConfig(name), name); e != nil {
			t.Fatal("valid reader DNS rejected")
		}
	}
	for _, name := range []string{"", "Reader.example", "127.0.0.1", "::1", "*.example", "reader.example.", "https://reader.example", "reader.example:7233", "reader example", "-reader.example", "reader-.example", strings.Repeat("a", 64) + ".example", strings.Repeat("a.", 127) + "a"} {
		if e := validate(makeConfig(name), name); e == nil {
			t.Errorf("invalid reader DNS accepted: %q", name)
		}
	}
	c := makeConfig("reader.example")
	c.Global.TLS.Frontend.Client.ServerName = "reader.example"
	if validate(c, "reader.example") == nil {
		t.Error("same public and reader SNI accepted")
	}
	c = makeConfig("reader.example")
	c.Global.TLS.Frontend.PerHostOverrides = nil
	if validate(c, "reader.example") == nil {
		t.Error("missing reader override accepted")
	}
}
