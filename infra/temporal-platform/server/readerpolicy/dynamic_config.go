package readerpolicy

import "go.temporal.io/server/common/dynamicconfig"

type pinnedDynamicConfig struct{ delegate dynamicconfig.Client }

var enforcedTokenNamespace = []dynamicconfig.ConstrainedValue{{Value: true}}

// Pin the native consumer value, including after file reload. Namespace state
// validation then compares caller-supplied names to the native token namespace.
func PinTokenNamespaceEnforcement(delegate dynamicconfig.Client) dynamicconfig.Client {
	if delegate == nil {
		delegate = dynamicconfig.NewNoopClient()
	}
	return &pinnedDynamicConfig{delegate}
}
func (p *pinnedDynamicConfig) GetValue(key dynamicconfig.Key) []dynamicconfig.ConstrainedValue {
	if key == dynamicconfig.EnableTokenNamespaceEnforcement.Key() {
		return enforcedTokenNamespace
	}
	return p.delegate.GetValue(key)
}
