package main

import (
	"go.temporal.io/server/common/config"
	"testing"
)

func secureConfiguration() *config.Config {
	cfg := &config.Config{}
	cfg.Global.Authorization.Authorizer = "default"
	cfg.Global.Authorization.ClaimMapper = "default"
	cfg.Global.Authorization.Audience = "platform-temporal"
	cfg.Global.Authorization.JWTKeyProvider.KeySourceURIs = []string{"https://jwks.example/keys"}
	cfg.Global.TLS.Frontend.Server = config.ServerTLS{
		RequireClientAuth: true, CertFile: "/secrets/server.crt", KeyFile: "/secrets/server.key",
		ClientCAFiles: []string{"/secrets/client-ca.crt"},
	}
	cfg.Global.TLS.Internode.Server = config.ServerTLS{RequireClientAuth: true,
		CertFile: "/secrets/internal.crt", KeyFile: "/secrets/internal.key", ClientCAFiles: []string{"/secrets/internal-ca.crt"}}
	return cfg
}

func TestConfigurationAdmission(t *testing.T) {
	if err := ValidateConfiguration(secureConfiguration()); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*config.Config){
		"noop mapper":      func(c *config.Config) { c.Global.Authorization.ClaimMapper = "" },
		"noop authorizer":  func(c *config.Config) { c.Global.Authorization.Authorizer = "" },
		"missing audience": func(c *config.Config) { c.Global.Authorization.Audience = "" },
		"missing JWKS":     func(c *config.Config) { c.Global.Authorization.JWTKeyProvider.KeySourceURIs = nil },
		"plaintext JWKS": func(c *config.Config) {
			c.Global.Authorization.JWTKeyProvider.KeySourceURIs[0] = "http://jwks.example/keys"
		},
		"unauthenticated internal frontend": func(c *config.Config) { c.Global.TLS.Internode.Server.RequireClientAuth = false },
		"missing client CA":                 func(c *config.Config) { c.Global.TLS.Frontend.Server.ClientCAFiles = nil },
		"missing server key":                func(c *config.Config) { c.Global.TLS.Frontend.Server.KeyFile = "" },
		"host override weakens auth": func(c *config.Config) {
			c.Global.TLS.Frontend.PerHostOverrides = map[string]config.ServerTLS{"alternate": {RequireClientAuth: false}}
		},
		"hostname verification disabled": func(c *config.Config) { c.Global.TLS.Frontend.Client.DisableHostVerification = true },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := secureConfiguration()
			mutate(cfg)
			if ValidateConfiguration(cfg) == nil {
				t.Fatal("unsafe configuration accepted")
			}
		})
	}
	if ValidateConfiguration(nil) == nil {
		t.Fatal("nil configuration accepted")
	}
}

func TestConfigurationAdmissionAllowsJwtOnlyFrontend(t *testing.T) {
	cfg := secureConfiguration()
	cfg.Global.TLS.Frontend.Server.RequireClientAuth = false
	cfg.Global.TLS.Frontend.Server.ClientCAFiles = nil
	if err := ValidateConfiguration(cfg); err != nil {
		t.Fatalf("JWT-only product frontend rejected: %v", err)
	}
}

func TestConfigurationAdmissionChecksEnabledFrontendMTLS(t *testing.T) {
	cfg := secureConfiguration()
	cfg.Global.TLS.Frontend.Server.RequireClientAuth = true
	cfg.Global.TLS.Frontend.Server.ClientCAFiles = nil
	if ValidateConfiguration(cfg) == nil {
		t.Fatal("enabled frontend mTLS without client CA accepted")
	}
}

func TestServiceSelection(t *testing.T) {
	got, err := ParseServices("")
	if err != nil || len(got) != 5 {
		t.Fatalf("default managed topology unavailable: %v", err)
	}
	got, err = ParseServices("frontend,internal-frontend")
	if err != nil || len(got) != 2 {
		t.Fatal("valid deployment topology denied")
	}
	for _, invalid := range []string{"frontend,frontend", "unknown", "frontend,", " frontend", "frontend,admin"} {
		if _, err := ParseServices(invalid); err == nil {
			t.Errorf("invalid topology accepted: %q", invalid)
		}
	}
}
