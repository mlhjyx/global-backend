package readerpolicy_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"global.local/temporal-platform-server/readerpolicy"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/server/common/authorization"
	"go.temporal.io/server/common/config"
	"go.temporal.io/server/common/log"
	"google.golang.org/grpc/credentials"
)

const reader = "growthos-platform-reader"
const namespace = "platform-automation"
const prefix = "/temporal.api.workflowservice.v1.WorkflowService/"

type keys struct{ key *rsa.PrivateKey }

func (k keys) SupportedMethods() []string { return []string{"RS256"} }
func (k keys) RsaKey(alg, kid string) (*rsa.PublicKey, error) {
	if alg != "RS256" || kid != "test-jwt" {
		return nil, errors.New("key unavailable")
	}
	return &k.key.PublicKey, nil
}
func (k keys) HmacKey(string, string) ([]byte, error) { return nil, errors.New("key unavailable") }
func (k keys) EcdsaKey(string, string) (*ecdsa.PublicKey, error) {
	return nil, errors.New("key unavailable")
}
func (k keys) Close() {}

func token(t *testing.T, key *rsa.PrivateKey, subject string, permissions []string) string {
	t.Helper()
	now := time.Now().Unix()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": subject, "aud": "temporal-platform",
		"iat": now - 1, "nbf": now - 1, "exp": now + 300, "permissions": permissions})
	tok.Header["kid"] = "test-jwt"
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatal("test signing failed")
	}
	return "Bearer " + signed
}

func setup(t *testing.T) (keys, authorization.ClaimMapper, authorization.Authorizer) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	provider := keys{key}
	delegate := authorization.NewDefaultJWTClaimMapper(provider, &config.Authorization{}, log.NewNoopLogger())
	mapper, err := readerpolicy.NewClaimMapper(delegate, reader)
	if err != nil {
		t.Fatal(err)
	}
	authorizer, err := readerpolicy.NewAuthorizer(reader)
	if err != nil {
		t.Fatal(err)
	}
	return provider, mapper, authorizer
}

// Obtains VerifiedChains from a real mutual TLS handshake, not a fabricated Claims type.
func verifiedTLS(t *testing.T, subject string, alternativeIdentity bool) *credentials.TLSInfo {
	return verifiedTLSAt(t, subject, alternativeIdentity, time.Now())
}

func verifiedJwtOnlyTLS() *credentials.TLSInfo {
	return &credentials.TLSInfo{State: tls.ConnectionState{HandshakeComplete: true}}
}

func verifiedTLSAt(t *testing.T, subject string, alternativeIdentity bool, handshakeTime time.Time) *credentials.TLSInfo {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-reader-ca"},
		NotBefore: handshakeTime.Add(-time.Hour), NotAfter: handshakeTime.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
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
	issue := func(serial int64, cn string, server bool) tls.Certificate {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		leaf := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn}, NotBefore: ca.NotBefore,
			NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
		if server {
			leaf.DNSNames = []string{"temporal.test"}
			leaf.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		}
		if !server && alternativeIdentity {
			leaf.DNSNames = []string{"another-reader.test"}
		}
		der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		return tls.Certificate{Certificate: [][]byte{der, caDER}, PrivateKey: key}
	}
	serverCert := issue(2, "temporal.test", true)
	clientCert := issue(3, subject, false)
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	deadline := time.Now().Add(5 * time.Second)
	if err = a.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if err = b.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	server := tls.Server(a, &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: pool, MinVersion: tls.VersionTLS12, SessionTicketsDisabled: true, Time: func() time.Time { return handshakeTime }})
	client := tls.Client(b, &tls.Config{Certificates: []tls.Certificate{clientCert}, RootCAs: pool, ServerName: "temporal.test", MinVersion: tls.VersionTLS12, Time: func() time.Time { return handshakeTime }})
	done := make(chan error, 1)
	go func() { done <- server.Handshake() }()
	if err = client.Handshake(); err != nil {
		t.Fatal("client handshake failed")
	}
	if err = <-done; err != nil {
		t.Fatal("server handshake failed")
	}
	state := server.ConnectionState()
	if len(state.VerifiedChains) == 0 {
		t.Fatal("no verified mTLS chain")
	}
	return &credentials.TLSInfo{State: state}
}

func targetFor(api, ns string) *authorization.CallTarget {
	target := &authorization.CallTarget{APIName: prefix + api, Namespace: ns}
	switch api {
	case "DescribeSchedule":
		target.Request = &workflowservice.DescribeScheduleRequest{Namespace: ns}
	case "DescribeWorkflowExecution":
		target.Request = &workflowservice.DescribeWorkflowExecutionRequest{Namespace: ns}
	case "GetWorkflowExecutionHistory":
		target.Request = &workflowservice.GetWorkflowExecutionHistoryRequest{Namespace: ns}
	case "ListWorkflowExecutions":
		target.Request = &workflowservice.ListWorkflowExecutionsRequest{Namespace: ns}
	case "DescribeNamespace":
		target.Request = &workflowservice.DescribeNamespaceRequest{Namespace: ns}
	case "StartWorkflowExecution":
		target.Request = &workflowservice.StartWorkflowExecutionRequest{Namespace: ns}
	case "UpdateSchedule":
		target.Request = &workflowservice.UpdateScheduleRequest{Namespace: ns}
	case "SignalWorkflowExecution":
		target.Request = &workflowservice.SignalWorkflowExecutionRequest{Namespace: ns}
	case "TerminateWorkflowExecution":
		target.Request = &workflowservice.TerminateWorkflowExecutionRequest{Namespace: ns}
	case "GetSystemInfo":
		target.Request = &workflowservice.GetSystemInfoRequest{}
	}
	return target
}

func TestReaderExactlyThreeRPCsAfterRealJWTAndMTLS(t *testing.T) {
	provider, mapper, authorizer := setup(t)
	info := &authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)}
	claims, err := mapper.GetClaims(info)
	if err != nil {
		t.Fatal("valid reader rejected")
	}
	for _, tc := range []struct {
		api, ns string
		allow   bool
	}{
		{"DescribeSchedule", namespace, true}, {"DescribeWorkflowExecution", namespace, true}, {"GetWorkflowExecutionHistory", namespace, true},
		{"ListWorkflowExecutions", namespace, false}, {"DescribeNamespace", namespace, false}, {"StartWorkflowExecution", namespace, false},
		{"UpdateSchedule", namespace, false}, {"SignalWorkflowExecution", namespace, false}, {"TerminateWorkflowExecution", namespace, false},
		{"DescribeSchedule", "other", false}, {"DescribeSchedule", "", false}, {"GetSystemInfo", "", false}, {"Unknown", namespace, false},
	} {
		t.Run(tc.api+"_"+tc.ns, func(t *testing.T) {
			got, err := authorizer.Authorize(context.Background(), claims, targetFor(tc.api, tc.ns))
			if err != nil || (got.Decision == authorization.DecisionAllow) != tc.allow {
				t.Fatalf("unexpected decision for method %s", tc.api)
			}
		})
	}
}

func TestReaderRejectsElevatedJWTAndIdentitySplicing(t *testing.T) {
	provider, mapper, _ := setup(t)
	peer := verifiedTLS(t, reader, false)
	for _, permissions := range [][]string{{namespace + ":write"}, {namespace + ":admin"}, {namespace + ":read", "temporal-system:admin"},
		{namespace + ":read", "other:read"}, {namespace + ":read", namespace + ":worker"}, {}} {
		_, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, reader, permissions), Audience: "temporal-platform", TLSConnection: peer})
		if err == nil {
			t.Fatal("elevated or absent reader role accepted")
		}
	}
	for _, tc := range []struct {
		subject string
		peer    *credentials.TLSInfo
	}{
		{reader, nil}, {reader, verifiedTLS(t, "other-reader", false)}, {"worker", peer}, {reader, verifiedTLS(t, reader, true)},
	} {
		_, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, tc.subject, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: tc.peer})
		if err == nil {
			t.Fatal("unbound certificate accepted")
		}
	}
	unverified := *peer
	unverified.State = peer.State
	unverified.State.VerifiedChains = nil
	_, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform",
		TLSConnection: &unverified, TLSSubject: &pkix.Name{CommonName: reader}})
	if err == nil {
		t.Fatal("unverified peer or TLSSubject trusted")
	}
}

func TestReaderAllowsVerifiedJwtOnlyFrontend(t *testing.T) {
	provider, mapper, _ := setup(t)
	_, err := mapper.GetClaims(&authorization.AuthInfo{
		AuthToken:     token(t, provider.key, reader, []string{namespace + ":read"}),
		Audience:      "temporal-platform",
		TLSConnection: verifiedJwtOnlyTLS(),
	})
	if err != nil {
		t.Fatalf("JWT-only frontend reader rejected: %v", err)
	}
}

func TestOfficialDelegateRejectsBadSignatureAndAudienceFirst(t *testing.T) {
	provider, mapper, _ := setup(t)
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for _, info := range []*authorization.AuthInfo{
		{AuthToken: token(t, other, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)},
		{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "wrong", TLSConnection: verifiedTLS(t, reader, false)},
	} {
		if _, err := mapper.GetClaims(info); err == nil {
			t.Fatal("invalid JWT accepted")
		}
	}
}

func TestNonReaderPreservesNativeDefaultsAndConcurrentReaderCalls(t *testing.T) {
	provider, mapper, authorizer := setup(t)
	info := &authorization.AuthInfo{AuthToken: token(t, provider.key, "worker", []string{namespace + ":write", namespace + ":worker"}), Audience: "temporal-platform"}
	claims, err := mapper.GetClaims(info)
	if err != nil {
		t.Fatal(err)
	}
	native := authorization.NewDefaultAuthorizer()
	for _, target := range []*authorization.CallTarget{{APIName: prefix + "StartWorkflowExecution", Namespace: namespace},
		{APIName: prefix + "DescribeSchedule", Namespace: namespace}, {APIName: prefix + "DescribeSchedule", Namespace: "other"}, {APIName: prefix + "GetSystemInfo"}} {
		got, e := authorizer.Authorize(context.Background(), claims, target)
		want, we := native.Authorize(context.Background(), claims, target)
		if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(e, we) {
			t.Fatal("non-reader semantics changed")
		}
	}
	readerInfo := &authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Go(func() {
			c, e := mapper.GetClaims(readerInfo)
			if e != nil {
				t.Error("concurrent mapping failed")
				return
			}
			r, e := authorizer.Authorize(context.Background(), c, targetFor("DescribeSchedule", namespace))
			if e != nil || r.Decision != authorization.DecisionAllow {
				t.Error("concurrent authorization failed")
			}
		})
	}
	wg.Wait()
}

func TestConfigurationRequiresExplicitReaderAndDelegate(t *testing.T) {
	for _, subject := range []string{"", " ", "reader\n", "reader/other"} {
		if _, err := readerpolicy.NewAuthorizer(subject); err == nil {
			t.Fatal("invalid subject accepted")
		}
	}
	if _, err := readerpolicy.NewClaimMapper(nil, reader); err == nil {
		t.Fatal("nil delegate accepted")
	}
}

func TestReaderCannotForgeMapperProofOrMutateItsRoleAfterMapping(t *testing.T) {
	provider, mapper, authorizer := setup(t)
	info := &authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)}
	claims, err := mapper.GetClaims(info)
	if err != nil {
		t.Fatal(err)
	}
	target := targetFor("DescribeSchedule", namespace)
	for _, forged := range []*authorization.Claims{
		{Subject: reader, AuthType: "jwt", Namespaces: map[string]authorization.Role{namespace: authorization.RoleReader}},
		{Subject: reader, AuthType: "jwt", System: authorization.RoleAdmin, Namespaces: map[string]authorization.Role{namespace: authorization.RoleReader}},
	} {
		r, err := authorizer.Authorize(context.Background(), forged, target)
		if err != nil || r.Decision != authorization.DecisionDeny {
			t.Fatal("unverified reader claims authorized")
		}
	}
	claims.System = authorization.RoleAdmin
	r, err := authorizer.Authorize(context.Background(), claims, target)
	if err != nil || r.Decision != authorization.DecisionDeny {
		t.Fatal("post-map role elevation authorized")
	}
}

func TestPreviouslyVerifiedConnectionCannotOutliveCertificateValidity(t *testing.T) {
	provider, mapper, _ := setup(t)
	for _, handshakeTime := range []time.Time{time.Now().Add(-2 * time.Hour), time.Now().Add(2 * time.Hour)} {
		peer := verifiedTLSAt(t, reader, false, handshakeTime)
		_, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: peer})
		if err == nil {
			t.Fatal("certificate invalid at request time accepted")
		}
	}
}

func TestReaderMethodMustMatchTypedRequestAndNamespace(t *testing.T) {
	provider, mapper, authorizer := setup(t)
	claims, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, reader, []string{namespace + ":read"}), Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)})
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []any{nil, (*workflowservice.DescribeScheduleRequest)(nil),
		&workflowservice.DescribeScheduleRequest{Namespace: "other"},
		&workflowservice.DescribeWorkflowExecutionRequest{Namespace: namespace},
		&workflowservice.StartWorkflowExecutionRequest{Namespace: namespace}} {
		r, err := authorizer.Authorize(context.Background(), claims, &authorization.CallTarget{APIName: prefix + "DescribeSchedule", Namespace: namespace, Request: request})
		if err != nil || r.Decision != authorization.DecisionDeny {
			t.Fatal("method/request substitution accepted")
		}
	}
}

func TestReaderRequiresIntegralExpIatNbfAfterOfficialSignatureVerification(t *testing.T) {
	provider, mapper, _ := setup(t)
	peer := verifiedTLS(t, reader, false)
	now := time.Now().Unix()
	for _, field := range []string{"exp", "iat", "nbf"} {
		validDate := now - 1
		if field == "exp" {
			validDate = now + 300
		}
		for _, value := range []any{nil, "123", 1.5, float64(now) + 0.25,
			json.Number(strconv.FormatInt(validDate, 10) + ".0"), json.Number(strconv.FormatInt(validDate, 10) + "e0"),
			json.Number("9223372036854775808")} {
			claims := jwt.MapClaims{"sub": reader, "aud": "temporal-platform", "permissions": []string{namespace + ":read"}, "exp": now + 300, "iat": now - 1, "nbf": now - 1}
			if value == nil {
				delete(claims, field)
			} else {
				claims[field] = value
			}
			tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
			tok.Header["kid"] = "test-jwt"
			signed, err := tok.SignedString(provider.key)
			if err != nil {
				t.Fatal("signing failed")
			}
			if _, err = mapper.GetClaims(&authorization.AuthInfo{AuthToken: "Bearer " + signed, Audience: "temporal-platform", TLSConnection: peer}); err == nil {
				t.Fatalf("invalid reader %s accepted", field)
			}
		}
	}
}

func TestReaderTimesDoNotIntroduceTTLOrNonReaderRestrictions(t *testing.T) {
	provider, mapper, authorizer := setup(t)
	now := time.Now().Unix()
	for _, subject := range []string{reader, "worker"} {
		claims := jwt.MapClaims{"sub": subject, "aud": "temporal-platform", "permissions": []string{namespace + ":read"}}
		info := &authorization.AuthInfo{Audience: "temporal-platform"}
		if subject == reader {
			claims["exp"] = now + 1000000
			claims["iat"] = now - 1000000
			claims["nbf"] = now - 1000000
			info.TLSConnection = verifiedTLS(t, reader, false)
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = "test-jwt"
		signed, err := tok.SignedString(provider.key)
		if err != nil {
			t.Fatal("signing failed")
		}
		info.AuthToken = "Bearer " + signed
		mapped, err := mapper.GetClaims(info)
		if err != nil {
			t.Fatal("new TTL or non-reader requirement introduced")
		}
		result, err := authorizer.Authorize(context.Background(), mapped, targetFor("DescribeSchedule", namespace))
		if err != nil || result.Decision != authorization.DecisionAllow {
			t.Fatal("valid existing scope rejected")
		}
	}
}
