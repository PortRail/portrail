import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLaunchdPlist, renderSystemdUnit, serviceInfo, systemdQuote } from "../src/service.ts";

test("the systemd unit quotes every token and escapes what systemd interprets", () => {
  const unit = renderSystemdUnit({
    node: "/usr/bin/node",
    cli: "/opt/p/bin/portrail.mjs",
    args: ["start", "--relay", "https://x/%s"],
    dataDir: '/home/me/My "Data" 100%',
    path: "/usr/bin",
  });
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/p\/bin\/portrail\.mjs" "start" "--relay" "https:\/\/x\/%%s"$/m);
  assert.match(unit, /^Environment="PORTRAIL_HOME=\/home\/me\/My \\"Data\\" 100%%"$/m);
  assert.match(unit, /^Environment="PATH=\/usr\/bin"$/m);
  assert.equal(systemdQuote("a\\b"), '"a\\\\b"');
});

test("the launchd plist escapes XML and points its log at the chosen data directory", () => {
  const plist = renderLaunchdPlist({ node: "/usr/bin/node", cli: "/opt/p/bin/portrail.mjs", args: ["start", "--name", "a<b"], dataDir: "/tmp/elsewhere", path: "/usr/bin", home: "/Users/me" });
  assert.match(plist, /<string>a&lt;b<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/tmp\/elsewhere\/portrail\.log<\/string>/);
  assert.match(plist, /<key>PORTRAIL_HOME<\/key><string>\/tmp\/elsewhere<\/string>/);
});

test("the service hints follow the chosen data directory", () => {
  assert.ok(serviceInfo("darwin", "/tmp/elsewhere").hints.some((hint) => hint === "tail -f /tmp/elsewhere/portrail.log"));
});
