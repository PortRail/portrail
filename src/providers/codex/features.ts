/**
 * Capabilities Portrail refuses to let the agent have, whatever the installed
 * version calls them.
 *
 * These are not the dangerous *actions* — running commands and editing files are
 * the entire point, and the policy layer governs those. These are capabilities that
 * would let the agent reach outside the boundary Portrail can see: third-party code,
 * another machine, a browser, or a second agent whose requests we cannot attribute.
 *
 * Deliberately absent: `code_mode_host`. Its name suggests a REPL, but in 0.147 it is
 * the host every command runs through — disable it and the agent can execute nothing.
 * The REPL-shaped MCP servers people see come from config.toml and plugins, which
 * are switched off per thread instead.
 */
export const REFUSED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "remote_control",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "js_repl",
  "multi_agent",
  "multi_agent_v2",
  "skill_mcp_dependency_install",
  "skill_search",
  "memories",
  "hooks",
  "image_generation",
  "workspace_dependencies",
  "realtime_conversation",
] as const;

/** Capabilities a working agent needs. Reported, not forced — they are on by default. */
export const REQUIRED_FEATURES = ["shell_tool", "unified_exec"] as const;

export interface AdvertisedFeature {
  name: string;
  enabled?: boolean;
  stage?: string;
}

export interface FeatureReport {
  /** `--disable` flags to pass at spawn: refused, known, currently on, not removed. */
  disable: string[];
  /** Required features this runtime reports as off or removed. */
  missing: string[];
}

/**
 * Reconcile our intent against what the installed runtime advertises.
 *
 * Feature names live nowhere in the protocol schema, and an unknown name on the
 * command line makes the process exit — so we only ever pass names this version has
 * confirmed. `experimentalFeature/enablement/set` looks like the runtime way to do
 * this but returns an empty result and changes nothing for the current process;
 * `--disable` at spawn is what actually works.
 */
export function reconcileFeatures(
  advertised: readonly AdvertisedFeature[],
): FeatureReport {
  const byName = new Map(advertised.map((feature) => [feature.name, feature]));
  const disable = REFUSED_FEATURES.filter((name) => {
    const feature = byName.get(name);
    return (
      feature !== undefined && feature.enabled !== false && feature.stage !== "removed"
    );
  });
  const missing = REQUIRED_FEATURES.filter((name) => {
    const feature = byName.get(name);
    return !feature || feature.enabled === false || feature.stage === "removed";
  });
  return { disable, missing };
}
