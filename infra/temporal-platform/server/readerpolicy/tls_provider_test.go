package readerpolicy_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"global.local/temporal-platform-server/readerpolicy"
	"go.temporal.io/server/common/config"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/metrics"
	"go.temporal.io/server/common/rpc/encryption"
)

func internodeFixture(t *testing.T) (encryption.TLSConfigProvider, *tls.Config) {
	t.Helper()
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "deliberately-shared-test-ca"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	issue := func(serial int64, cn string, internal bool) (tls.Certificate, []byte, []byte) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn}, KeyUsage: x509.KeyUsageDigitalSignature,
			ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter}
		if internal {
			template.DNSNames = []string{"internode.test"}
			template.ExtKeyUsage = append(template.ExtKeyUsage, x509.ExtKeyUsageServerAuth)
		}
		der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der, caDER}, PrivateKey: key}, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	}
	_, serverCert, serverKey := issue(2, "temporal-internode", true)
	readerCert, _, _ := issue(3, reader, false)
	dir := t.TempDir()
	certPath := filepath.Join(dir, "server.pem")
	keyPath := filepath.Join(dir, "server.key")
	caPath := filepath.Join(dir, "ca.pem")
	for path, data := range map[string][]byte{certPath: serverCert, keyPath: serverKey, caPath: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	provider, err := encryption.NewTLSConfigProviderFromConfig(config.RootTLS{Internode: config.GroupTLS{
		Server: config.ServerTLS{CertFile: certPath, KeyFile: keyPath, ClientCAFiles: []string{caPath}, RequireClientAuth: true},
		Client: config.ClientTLS{ServerName: "internode.test", RootCAFiles: []string{caPath}},
	}}, metrics.NoopMetricsHandler, log.NewNoopLogger(), nil)
	if err != nil {
		t.Fatal("native provider construction failed")
	}
	t.Cleanup(func() {
		if close, ok := provider.(interface{ Close() }); ok {
			close.Close()
		}
	})
	return provider, &tls.Config{RootCAs: pool, Certificates: []tls.Certificate{readerCert}, ServerName: "internode.test", MinVersion: tls.VersionTLS12}
}

func handshake(t *testing.T, serverConfig, clientConfig *tls.Config) error {
	t.Helper()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	deadline := time.Now().Add(3 * time.Second)
	if err := a.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if err := b.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	serverCopy := serverConfig.Clone()
	serverCopy.SessionTicketsDisabled = true
	server := tls.Server(a, serverCopy)
	client := tls.Client(b, clientConfig.Clone())
	done := make(chan error, 1)
	go func() { err := server.Handshake(); _ = a.Close(); done <- err }()
	clientErr := client.Handshake()
	if clientErr == nil {
		_, _ = client.Read(make([]byte, 1))
	}
	serverErr := <-done
	if serverErr != nil {
		return serverErr
	}
	return clientErr
}

func TestInternodeRejectsReaderDuringNativeTLSHandshakeEvenWithSharedCA(t *testing.T) {
	native, readerClient := internodeFixture(t)
	original, err := native.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, original, readerClient); err != nil {
		t.Fatal("baseline shared-CA reader handshake did not establish the regression")
	}
	wrapped, err := readerpolicy.NewTLSConfigProvider(native, reader)
	if err != nil {
		t.Fatal(err)
	}
	protected, err := wrapped.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, protected, readerClient); err == nil {
		t.Fatal("reader crossed internode TLS boundary")
	}
	if err = handshake(t, original, readerClient); err != nil {
		t.Fatal("wrapper mutated native cached config")
	}
	internal, err := wrapped.GetInternodeClientConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, protected, internal); err != nil {
		t.Fatal("normal native internode identity rejected")
	}
}

func TestDynamicTLSSelectionAndOriginalVerifierCannotBeBypassed(t *testing.T) {
	native, readerClient := internodeFixture(t)
	base, err := native.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	internal, err := native.GetInternodeClientConfig()
	if err != nil {
		t.Fatal(err)
	}
	selected := base.Clone()
	selected.GetConfigForClient = nil
	root := base.Clone()
	root.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { return selected, nil }
	provider := &encryption.FixedTLSConfigProvider{InternodeServerConfig: root}
	wrapped, err := readerpolicy.NewTLSConfigProvider(provider, reader)
	if err != nil {
		t.Fatal(err)
	}
	protected, err := wrapped.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, protected, readerClient); err == nil {
		t.Fatal("SNI returned an unguarded TLS config")
	}
	if err = handshake(t, protected, internal); err != nil {
		t.Fatal("SNI rejected valid internal peer")
	}
	selected.VerifyConnection = func(tls.ConnectionState) error { return errors.New("UPSTREAM_VERIFY_DENIED") }
	if err = handshake(t, protected, internal); err == nil {
		t.Fatal("original VerifyConnection veto bypassed")
	}
	selected.VerifyConnection = nil
	selected.VerifyPeerCertificate = func([][]byte, [][]*x509.Certificate) error { return errors.New("UPSTREAM_PEER_DENIED") }
	if err = handshake(t, protected, internal); err == nil {
		t.Fatal("original VerifyPeerCertificate veto bypassed")
	}
	selected.VerifyPeerCertificate = nil
	root.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { return nil, nil }
	protected, err = wrapped.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, protected, readerClient); err == nil {
		t.Fatal("nil dynamic selection bypassed base guard")
	}
	root.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) { return nil, errors.New("UPSTREAM_SNI_DENIED") }
	protected, err = wrapped.GetInternodeServerConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err = handshake(t, protected, internal); err == nil {
		t.Fatal("original dynamic selection veto bypassed")
	}
}

func TestInternodeWrapperRejectsMissingConfiguration(t *testing.T) {
	if _, err := readerpolicy.NewTLSConfigProvider(nil, reader); err == nil {
		t.Fatal("nil provider accepted")
	}
	if _, err := readerpolicy.NewTLSConfigProvider(&encryption.FixedTLSConfigProvider{}, ""); err == nil {
		t.Fatal("empty reader subject accepted")
	}
	provider, err := readerpolicy.NewTLSConfigProvider(&encryption.FixedTLSConfigProvider{}, reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.GetInternodeServerConfig(); err == nil {
		t.Fatal("plaintext internode fallback accepted")
	}
}
