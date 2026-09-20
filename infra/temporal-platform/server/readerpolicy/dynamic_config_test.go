package readerpolicy_test

import (
	"context"
	"errors"
	"global.local/temporal-platform-server/readerpolicy"
	enumspb "go.temporal.io/api/enums/v1"
	ws "go.temporal.io/api/workflowservice/v1"
	persistence "go.temporal.io/server/api/persistence/v1"
	tokenspb "go.temporal.io/server/api/token/v1"
	"go.temporal.io/server/common/dynamicconfig"
	"go.temporal.io/server/common/log"
	ns "go.temporal.io/server/common/namespace"
	"go.temporal.io/server/common/rpc/interceptor"
	"go.temporal.io/server/common/tasktoken"
	"google.golang.org/grpc"
	"testing"
)

func TestNativeNamespaceEnforcementCannotBeDisabled(t *testing.T) {
	source := dynamicconfig.StaticClient{dynamicconfig.EnableTokenNamespaceEnforcement.Key(): false}
	collection := dynamicconfig.NewCollection(readerpolicy.PinTokenNamespaceEnforcement(source), log.NewNoopLogger())
	if !dynamicconfig.EnableTokenNamespaceEnforcement.Get(collection)() {
		t.Fatal("native namespace consumer accepts disabled token enforcement")
	}
}

// The registry replaces persistence only; both namespace interceptors, native
// token serialization, and the dynamic setting consumer below are upstream code.
type namespaceFixture struct {
	ns.Registry
	entries map[string]*ns.Namespace
}

func (r namespaceFixture) GetNamespace(name ns.Name) (*ns.Namespace, error) {
	for _, entry := range r.entries {
		if entry.Name() == name {
			return entry, nil
		}
	}
	return nil, errors.New("unknown namespace")
}
func (r namespaceFixture) GetNamespaceByID(id ns.ID) (*ns.Namespace, error) {
	entry := r.entries[string(id)]
	if entry == nil {
		return nil, errors.New("unknown namespace")
	}
	return entry, nil
}
func TestNativeTokenNamespaceMismatchCannotReachHandler(t *testing.T) {
	registry := namespaceFixture{entries: map[string]*ns.Namespace{}}
	for _, name := range []string{"default", "platform-automation"} {
		registry.entries[name+"-id"] = ns.NewLocalNamespaceForTest(&persistence.NamespaceInfo{Id: name + "-id", Name: name, State: enumspb.NAMESPACE_STATE_REGISTERED}, &persistence.NamespaceConfig{}, "cluster")
	}
	source := dynamicconfig.StaticClient{dynamicconfig.EnableTokenNamespaceEnforcement.Key(): false}
	collection := dynamicconfig.NewCollection(readerpolicy.PinTokenNamespaceEnforcement(source), log.NewNoopLogger())
	native := interceptor.NewNamespaceValidatorInterceptor(registry, dynamicconfig.EnableTokenNamespaceEnforcement.Get(collection), func() int { return 255 })
	raw, _ := tasktoken.NewSerializer().Serialize(&tokenspb.Task{NamespaceId: "default-id", WorkflowId: "wf", RunId: "run", ScheduledEventId: 1})
	for _, name := range []string{"", "default", "platform-automation"} {
		called := false
		req := &ws.RespondWorkflowTaskCompletedRequest{Namespace: name, TaskToken: raw}
		info := &grpc.UnaryServerInfo{FullMethod: prefix + "RespondWorkflowTaskCompleted"}
		_, err := native.NamespaceValidateIntercept(context.Background(), req, info, func(ctx context.Context, req any) (any, error) {
			return native.StateValidationIntercept(ctx, req, info, func(context.Context, any) (any, error) { called = true; return nil, nil })
		})
		if name == "platform-automation" {
			if err == nil || called {
				t.Fatal("mismatched token namespace reached handler")
			}
		} else if err != nil || !called || req.Namespace != "default" {
			t.Fatal("native token namespace resolution failed")
		}
	}
}
