/**
 * Portrail as a library. `portrail/client` is the SDK for talking to a running
 * gateway; this entry is for embedding or testing the gateway itself.
 */
export {
  assemble,
  startDaemon,
  runningDaemon,
  type Daemon,
  type DaemonOptions,
} from "./daemon.ts";
export { Gateway, type GatewayOptions, type CreateRunInput } from "./core/gateway.ts";
export { createApp, runView, type ServerOptions } from "./server/app.ts";
export {
  Store,
  digest,
  id,
  now,
  secret,
  canonical,
  equal,
  type PortrailEvent,
  type RecordFilter,
  type SelectOptions,
} from "./store/index.ts";
export {
  Keys,
  publicKey,
  SCOPES,
  type KeyRecord,
  type Principal,
  type Scope,
} from "./core/keys.ts";
export { BuiltinDecider } from "./decide/builtin.ts";
export { loadExtension } from "./extension-loader.ts";
export {
  loadConfig,
  saveConfig,
  validateConfig,
  DEFAULT_CONFIG,
  type PortrailConfig,
} from "./config.ts";
export { dataDirectory, ensurePrivateDirectory } from "./store/paths.ts";
export { FakeProvider } from "./providers/fake/index.ts";
export { CodexProvider } from "./providers/codex/index.ts";
export { ClaudeProvider } from "./providers/claude/index.ts";
export type {
  Provider,
  ProviderHandle,
  ProviderStatus,
  ProviderEvent,
  RunContext,
  RunOutcome,
} from "./providers/types.ts";
export type { RunRecord, SessionRecord, OperationRecord } from "./core/records.ts";
export type * from "./types.ts";
export type {
  Extension,
  ExtensionHost,
  Decider,
  DecisionContext,
} from "./extension.ts";
export { version } from "./runtime.ts";
