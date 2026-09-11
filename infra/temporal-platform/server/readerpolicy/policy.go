// Package readerpolicy constrains the dedicated GrowthOS reader on Temporal's
// official server authorization interfaces. Non-reader policy remains native.
package readerpolicy

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/server/common/authorization"
)

const readerNamespace = "platform-automation"
const workflowService = "/temporal.api.workflowservice.v1.WorkflowService/"

type claimMapper struct {
	delegate authorization.ClaimMapper
	subject  string
}

type authorizer struct {
	delegate authorization.Authorizer
	subject  string
}

// An unexported typed marker cannot be supplied as an extra JWT claim. It is
// created only after both the official JWT delegate and mTLS checks succeed.
type verifiedReader struct{ subject string }

var _ authorization.ClaimMapper = (*claimMapper)(nil)
var _ authorization.Authorizer = (*authorizer)(nil)

// NewClaimMapper wraps the server's official, signature-verifying JWT mapper.
// Configuration must never supply a no-op mapper or an unsigned substitute.

func NewClaimMapper(delegate authorization.ClaimMapper, readerSubject string) (authorization.ClaimMapper, error) {
	if delegate == nil || !validSubject(readerSubject) {
		return nil, errors.New("PLATFORM_TEMPORAL_READER_CONFIG_INVALID")
	}
	return &claimMapper{delegate: delegate, subject: readerSubject}, nil
}

// NewAuthorizer applies the dedicated reader allowlist before native default
// authorization, preserving the native policy for all other identities.
func NewAuthorizer(readerSubject string) (authorization.Authorizer, error) {
	if !validSubject(readerSubject) {
		return nil, errors.New("PLATFORM_TEMPORAL_READER_CONFIG_INVALID")
	}
	return &authorizer{delegate: authorization.NewDefaultAuthorizer(), subject: readerSubject}, nil
}

func validSubject(subject string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`).MatchString(subject)
}

func denied() error {
	return serviceerror.NewPermissionDenied("PLATFORM_TEMPORAL_READER_AUTH_DENIED", "")
}

func (m *claimMapper) GetClaims(info *authorization.AuthInfo) (*authorization.Claims, error) {
	if info == nil {
		return nil, denied()
	}
	// Never classify an unverified JWT by decoding its subject ourselves.
	snapshot := *info
	verifiedToken := snapshot.AuthToken
	claims, err := m.delegate.GetClaims(&snapshot)
	if err != nil || claims == nil || snapshot.AuthToken != verifiedToken {
		return nil, denied()
	}
	leaf := verifiedPeerLeaf(info)
	if claims.Subject != m.subject {
		// A reader certificate must not be paired with a privileged non-reader JWT.
		if leaf != nil && leaf.Subject.CommonName == m.subject {
			return nil, denied()
		}
		return claims, nil
	}
	if claims.AuthType != "jwt" || strings.TrimSpace(info.Audience) == "" || !exactReaderRole(claims) ||
		info.TLSConnection == nil || !info.TLSConnection.State.HandshakeComplete {
		return nil, denied()
	}
	// Public frontend may use JWT-only. If a client certificate is presented,
	// bind it to the reader subject; an unverified or mismatched certificate is
	// never accepted as a substitute for the JWT identity.
	if leaf == nil && (len(info.TLSConnection.State.PeerCertificates) != 0 || len(info.TLSConnection.State.VerifiedChains) != 0) {
		return nil, denied()
	}
	if leaf != nil && !singleReaderIdentity(leaf, m.subject) {
		return nil, denied()
	}
	now := time.Now()
	if !readerTimes(verifiedToken, now.Unix()) {
		return nil, denied()
	}
	// VerifiedChains proves handshake-time validation. Recheck the selected full
	// chain on every request so a long-lived connection cannot outlive its proof.
	if leaf != nil {
		for _, chain := range info.TLSConnection.State.VerifiedChains {
			for _, cert := range chain {
				if cert == nil || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
					return nil, denied()
				}
			}
		}
	}
	copy := *claims
	copy.Namespaces = map[string]authorization.Role{readerNamespace: authorization.RoleReader}
	copy.Extensions = verifiedReader{subject: m.subject}
	return &copy, nil
}

// The official delegate has already verified this exact compact token. Parse
// only to enforce the existing reader selector's required integral NumericDates;
// this is not a second signature verifier or a new TTL/authorization policy.
func readerTimes(authorizationHeader string, now int64) bool {
	parts := strings.SplitN(authorizationHeader, " ", 2)
	if len(parts) != 2 {
		return false
	}
	compact := strings.Split(parts[1], ".")
	if len(compact) != 3 {
		return false
	}
	bytes, err := base64.RawURLEncoding.DecodeString(compact[1])
	if err != nil {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(bytes)))
	decoder.UseNumber()
	var claims map[string]any
	if err = decoder.Decode(&claims); err != nil {
		return false
	}
	times := make(map[string]int64, 3)
	for _, field := range []string{"exp", "iat", "nbf"} {
		value, ok := claims[field].(json.Number)
		if !ok {
			return false
		}
		number, err := value.Int64()
		if err != nil {
			return false
		}
		times[field] = number
	}
	return times["exp"] > now && times["iat"] <= now && times["nbf"] <= now
}

func verifiedPeerLeaf(info *authorization.AuthInfo) *x509.Certificate {
	if info.TLSConnection == nil || !info.TLSConnection.State.HandshakeComplete {
		return nil
	}
	state := info.TLSConnection.State
	leaf := authorization.PeerCert(info.TLSConnection)
	if leaf == nil || len(leaf.Raw) == 0 || len(state.PeerCertificates) == 0 || state.PeerCertificates[0] == nil ||
		!bytes.Equal(leaf.Raw, state.PeerCertificates[0].Raw) {
		return nil
	}
	for _, chain := range state.VerifiedChains {
		if len(chain) == 0 || chain[0] == nil || !bytes.Equal(leaf.Raw, chain[0].Raw) {
			return nil
		}
	}
	return leaf
}

func singleReaderIdentity(cert *x509.Certificate, subject string) bool {
	if cert.Subject.CommonName != subject || cert.IsCA || len(cert.DNSNames) != 0 || len(cert.IPAddresses) != 0 ||
		len(cert.EmailAddresses) != 0 || len(cert.URIs) != 0 || len(cert.ExtKeyUsage) != 1 ||
		cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth || len(cert.UnknownExtKeyUsage) != 0 ||
		cert.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return false
	}
	commonNames := 0
	for _, name := range cert.Subject.Names {
		if name.Type.Equal(asn1.ObjectIdentifier{2, 5, 4, 3}) {
			commonNames++
			value, ok := name.Value.(string)
			if !ok || value != subject {
				return false
			}
		}
	}
	return commonNames == 1
}

func exactReaderRole(claims *authorization.Claims) bool {
	return claims.System == authorization.RoleUndefined && len(claims.Namespaces) == 1 &&
		claims.Namespaces[readerNamespace] == authorization.RoleReader
}

func (a *authorizer) Authorize(ctx context.Context, claims *authorization.Claims, target *authorization.CallTarget) (authorization.Result, error) {
	deny := authorization.Result{Decision: authorization.DecisionDeny, Reason: "PLATFORM_TEMPORAL_READER_POLICY_DENIED"}
	if target == nil {
		return deny, nil
	}
	if claims == nil {
		return a.delegate.Authorize(ctx, claims, target)
	}
	proof, proved := claims.Extensions.(verifiedReader)
	if claims.Subject != a.subject {
		if proved {
			return deny, nil
		}
		return a.delegate.Authorize(ctx, claims, target)
	}
	if !proved || proof.subject != a.subject || !exactReaderRole(claims) || target.Namespace != readerNamespace {
		return deny, nil
	}
	// Match both the full gRPC method and its actual decoded request type. The
	// interceptor-supplied target namespace cannot override a request namespace.
	allowed := false
	switch request := target.Request.(type) {
	case *workflowservice.DescribeScheduleRequest:
		allowed = request != nil && target.APIName == workflowService+"DescribeSchedule" && request.GetNamespace() == readerNamespace
	case *workflowservice.DescribeWorkflowExecutionRequest:
		allowed = request != nil && target.APIName == workflowService+"DescribeWorkflowExecution" && request.GetNamespace() == readerNamespace
	case *workflowservice.GetWorkflowExecutionHistoryRequest:
		allowed = request != nil && target.APIName == workflowService+"GetWorkflowExecutionHistory" && request.GetNamespace() == readerNamespace
	}
	if !allowed {
		return deny, nil
	}
	return a.delegate.Authorize(ctx, claims, target)
}
