/**
 * Live end-to-end: both real agents, real files, real refusals. Uses inference.
 *
 *   npm run e2e            both agents
 *   npm run e2e -- codex   one agent
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const only = process.argv[2];
const agents = only ? [only] : ["codex", "claude"];
const script = fileURLToPath(new URL("./e2e-agent.ts", import.meta.url));
const results: Array<{ agent: string; pass: boolean; seconds: number }> = [];

for (const agent of agents) {
  const started = Date.now();
  console.log(`\n━━━ ${agent} ━━━`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script, agent], { stdio: "inherit", timeout: 300_000 });
  results.push({ agent, pass: result.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\n━━━ summary ━━━");
for (const { agent, pass, seconds } of results) console.log(`  ${pass ? "PASS" : "FAIL"}  ${agent.padEnd(8)} ${seconds}s`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
