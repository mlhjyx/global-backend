package main

import (
	"bytes"
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"go.temporal.io/server/common/config"
)

type trustTestCA struct {
	certificate *x509.Certificate
	key         crypto.Signer
	pem         []byte
}

func trustMakeCA(t *testing.T, name string, parent *trustTestCA, signer crypto.Signer, future bool) trustTestCA {
	t.Helper()
	if signer == nil {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		signer = key
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	if future {
		template.NotBefore = time.Now().Add(time.Hour)
	}
	parentCert, parentKey := template, signer
	if parent != nil {
		parentCert, parentKey = parent.certificate, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, template, parentCert, signer.Public(), parentKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return trustTestCA{certificate, signer, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func trustWriteCA(t *testing.T, directory, name string, contents []byte) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, contents, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func trustConfiguration(frontend, internode []string) *config.Config {
	cfg := &config.Config{}
	cfg.Global.TLS.Frontend.Server.ClientCAFiles = frontend
	cfg.Global.TLS.Internode.Server.ClientCAFiles = internode
	// This validator must never inspect certificate/private-key material paths.
	cfg.Global.TLS.Frontend.Server.KeyFile = "/must-not-read/private.key"
	cfg.Global.TLS.Internode.Server.KeyFile = "/must-not-read/internal.key"
	return cfg
}

func trustRejected(t *testing.T, cfg *config.Config) {
	t.Helper()
	err := ValidateTrustDomains(cfg)
	if err == nil {
		t.Fatal("unsafe trust configuration was accepted")
	}
	if err.Error() != "TEMPORAL_PLATFORM_TRUST_DOMAINS_INVALID" {
		t.Fatalf("unbounded error: %v", err)
	}
}

func TestTrustIndependentDomainsAndRotation(t *testing.T) {
	directory := t.TempDir()
	frontend := trustMakeCA(t, "frontend", nil, nil, false)
	internal := trustMakeCA(t, "internode", nil, nil, false)
	rotated := trustMakeCA(t, "frontend-rotated", nil, frontend.key, false)
	staged := trustMakeCA(t, "frontend-future", nil, nil, true)
	intermediate := trustMakeCA(t, "frontend-intermediate", &frontend, nil, false)
	frontPath := trustWriteCA(t, directory, "frontend.pem", bytes.Join([][]byte{frontend.pem, rotated.pem, staged.pem, intermediate.pem}, nil))
	internalPath := trustWriteCA(t, directory, "internal.pem", internal.pem)
	if err := os.Chmod(frontPath, 0644); err != nil {
		t.Fatal(err)
	}
	cfg := trustConfiguration([]string{frontPath}, []string{internalPath})
	cfg.Global.TLS.Frontend.PerHostOverrides = map[string]config.ServerTLS{"reader": {ClientCAFiles: []string{frontPath}}}
	cfg.Global.TLS.Internode.PerHostOverrides = map[string]config.ServerTLS{"history": {ClientCAFiles: []string{internalPath}}}
	if err := ValidateTrustDomains(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestTrustAllowsJwtOnlyFrontendWithoutClientCA(t *testing.T) {
	directory := t.TempDir()
	internal := trustMakeCA(t, "internode", nil, nil, false)
	internalPath := trustWriteCA(t, directory, "internal.pem", internal.pem)
	cfg := trustConfiguration(nil, []string{internalPath})
	cfg.Global.TLS.Frontend.Server.RequireClientAuth = false
	cfg.Global.TLS.Internode.Server.RequireClientAuth = true
	if err := ValidateTrustDomains(cfg); err != nil {
		t.Fatalf("JWT-only frontend trust configuration rejected: %v", err)
	}
}

func TestTrustRejectsSharedKeysAndKnownCrossSignatures(t *testing.T) {
	frontend := trustMakeCA(t, "frontend", nil, nil, false)
	internal := trustMakeCA(t, "internal", nil, nil, false)
	sameKey := trustMakeCA(t, "different-certificate", nil, frontend.key, false)
	cross := trustMakeCA(t, "frontend-signed-by-internal", &internal, nil, false)
	futureCross := trustMakeCA(t, "future-cross-sign", &internal, nil, true)
	bridge := trustMakeCA(t, "bridge", &internal, nil, false)
	chained := trustMakeCA(t, "frontend-chained", &bridge, nil, false)
	tests := []struct {
		name            string
		front, internal []byte
	}{
		{"same-pem-different-path", frontend.pem, frontend.pem},
		{"same-key-different-certificate", frontend.pem, sameKey.pem},
		{"direct-cross-sign", cross.pem, internal.pem},
		{"reverse-cross-sign", internal.pem, cross.pem},
		{"staged-cross-sign", futureCross.pem, internal.pem},
		{"known-intermediate-chain", append(append([]byte{}, chained.pem...), bridge.pem...), internal.pem},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			front := trustWriteCA(t, dir, "front.pem", test.front)
			internal := trustWriteCA(t, dir, "internal.pem", test.internal)
			trustRejected(t, trustConfiguration([]string{front}, []string{internal}))
		})
	}
}

func TestTrustChecksEveryHostOverride(t *testing.T) {
	dir := t.TempDir()
	front := trustWriteCA(t, dir, "front.pem", trustMakeCA(t, "front", nil, nil, false).pem)
	internal := trustWriteCA(t, dir, "internal.pem", trustMakeCA(t, "internal", nil, nil, false).pem)
	for _, direction := range []string{"frontend", "internode"} {
		t.Run(direction, func(t *testing.T) {
			cfg := trustConfiguration([]string{front}, []string{internal})
			if direction == "frontend" {
				cfg.Global.TLS.Frontend.PerHostOverrides = map[string]config.ServerTLS{"hidden": {ClientCAFiles: []string{internal}}}
			}
			if direction == "internode" {
				cfg.Global.TLS.Internode.PerHostOverrides = map[string]config.ServerTLS{"hidden": {ClientCAFiles: []string{front}}}
			}
			trustRejected(t, cfg)
		})
	}
	cfg := trustConfiguration([]string{front}, []string{internal})
	cfg.Global.TLS.Frontend.PerHostOverrides = map[string]config.ServerTLS{"empty": {}}
	trustRejected(t, cfg)
}

func TestTrustRejectsMalformedCertificates(t *testing.T) {
	valid := trustMakeCA(t, "valid", nil, nil, false)
	peer := trustMakeCA(t, "independent-peer", nil, nil, false)
	notCA := &x509.Certificate{SerialNumber: big.NewInt(9), Subject: pkix.Name{CommonName: "not-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, notCA, valid.certificate, valid.key.Public(), valid.key)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		data []byte
	}{
		{"empty", nil}, {"garbage", []byte("not PEM")}, {"oversize", bytes.Repeat([]byte("x"), 65537)},
		{"wrong-block", pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte{1, 2}})},
		{"invalid-der", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2}})},
		{"non-ca", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})},
		{"preamble", append([]byte("ignored garbage\n"), valid.pem...)},
		{"trailing-garbage", append(append([]byte{}, valid.pem...), []byte("garbage")...)},
		{"malformed-before-valid", append([]byte("-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n"), valid.pem...)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			front := trustWriteCA(t, dir, "front.pem", test.data)
			internal := trustWriteCA(t, dir, "internal.pem", peer.pem)
			trustRejected(t, trustConfiguration([]string{front}, []string{internal}))
		})
	}
	trustRejected(t, nil)
	trustRejected(t, &config.Config{})
}

func TestTrustRejectsInlineAndUnboundedCAConfiguration(t *testing.T) {
	dir := t.TempDir()
	frontCA := trustMakeCA(t, "front", nil, nil, false)
	front := trustWriteCA(t, dir, "front.pem", frontCA.pem)
	internal := trustWriteCA(t, dir, "internal.pem", trustMakeCA(t, "internal", nil, nil, false).pem)
	cfg := trustConfiguration([]string{front}, []string{internal})
	cfg.Global.TLS.Frontend.Server.ClientCAData = []string{"inline-cannot-override-files"}
	trustRejected(t, cfg)
	cfg = trustConfiguration([]string{front}, []string{filepath.Join(dir, "missing-internal.pem")})
	trustRejected(t, cfg)
	cfg = trustConfiguration([]string{front}, []string{internal})
	cfg.Global.TLS.Frontend.Server.ClientCAFiles = make([]string, 65)
	for i := range cfg.Global.TLS.Frontend.Server.ClientCAFiles {
		cfg.Global.TLS.Frontend.Server.ClientCAFiles[i] = front
	}
	trustRejected(t, cfg)
	cfg = trustConfiguration([]string{front}, []string{internal})
	cfg.Global.TLS.Frontend.PerHostOverrides = make(map[string]config.ServerTLS)
	for i := 0; i < 65; i++ {
		cfg.Global.TLS.Frontend.PerHostOverrides[string(rune('a'+i))] = config.ServerTLS{ClientCAFiles: []string{front}}
	}
	trustRejected(t, cfg)
	largeBundle := trustWriteCA(t, dir, "many-cas.pem", bytes.Repeat(frontCA.pem, 129))
	trustRejected(t, trustConfiguration([]string{largeBundle}, []string{internal}))
}

func TestTrustRejectsUnsafeFilesAndParents(t *testing.T) {
	frontCA := trustMakeCA(t, "front", nil, nil, false)
	internalCA := trustMakeCA(t, "internal", nil, nil, false)
	for _, name := range []string{"symlink", "directory", "fifo", "group-write", "other-write", "missing", "relative", "unclean", "parent-symlink", "parent-writable", "untrusted-owner"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			front := trustWriteCA(t, dir, "front.pem", frontCA.pem)
			internal := trustWriteCA(t, dir, "internal.pem", internalCA.pem)
			switch name {
			case "symlink":
				link := filepath.Join(dir, "alias.pem")
				if err := os.Symlink(front, link); err != nil {
					t.Fatal(err)
				}
				front = link
			case "directory":
				front = dir
			case "fifo":
				front = filepath.Join(dir, "pipe")
				if err := syscall.Mkfifo(front, 0600); err != nil {
					t.Fatal(err)
				}
			case "group-write":
				if err := os.Chmod(front, 0660); err != nil {
					t.Fatal(err)
				}
			case "other-write":
				if err := os.Chmod(front, 0602); err != nil {
					t.Fatal(err)
				}
			case "missing":
				front = filepath.Join(dir, "missing.pem")
			case "relative":
				front = "relative.pem"
			case "unclean":
				front = dir + "/./front.pem"
			case "parent-symlink":
				alias := filepath.Join(dir, "alias")
				if err := os.Symlink(dir, alias); err != nil {
					t.Fatal(err)
				}
				front = filepath.Join(alias, "front.pem")
			case "parent-writable":
				unsafe := filepath.Join(dir, "unsafe")
				if err := os.Mkdir(unsafe, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(unsafe, 0777); err != nil {
					t.Fatal(err)
				}
				front = trustWriteCA(t, unsafe, "front.pem", frontCA.pem)
			case "untrusted-owner":
				if os.Geteuid() != 0 {
					t.Skip("chown negative needs root; hermetic container runs as root")
				}
				if err := os.Chown(front, 54321, 54321); err != nil {
					t.Fatal(err)
				}
			}
			trustRejected(t, trustConfiguration([]string{front}, []string{internal}))
		})
	}
}

func TestTrustAllowsTrustedStickyAncestor(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sticky")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, os.ModeSticky|0777); err != nil {
		t.Fatal(err)
	}
	front := trustWriteCA(t, dir, "front.pem", trustMakeCA(t, "front", nil, nil, false).pem)
	internal := trustWriteCA(t, dir, "internal.pem", trustMakeCA(t, "internal", nil, nil, false).pem)
	if err := ValidateTrustDomains(trustConfiguration([]string{front}, []string{internal})); err != nil {
		t.Fatal(err)
	}
}
