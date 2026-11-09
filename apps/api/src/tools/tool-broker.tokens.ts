/**
 * Nest DI token for the platform ToolBroker composition（与 TOOL_BUDGET_STORE 同模式）。
 *
 * 单独成文件而不是挂进 tool-broker.ts/tool-broker.factory.ts：那两个是执行面**受保护
 * 接线文件**（docs/governance/durable-result-strategies.json 重钉 sha256 才可改），
 * 加一个纯 token 不值得动闸门哈希。
 */
export const TOOL_BROKER = Symbol('TOOL_BROKER');
