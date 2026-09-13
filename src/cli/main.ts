import { BOOLEAN_FLAGS, parseArgs, flagBool, flagString } from "./args.ts";
import { COMMAND_HELP, HELP } from "./help.ts";
import { PortrailError } from "../contracts/errors.ts";
import { version } from "../runtime.ts";

/** The general help, plus whatever commands an installed extension adds. */
async function fullHelp(): Promise<string> {
  const { loadExtension } = await import("../extension-loader.ts");
  const { extension } = await loadExtension().catch(() => ({ extension: null }));
  const commands = Object.entries(extension?.commands ?? {});
  if (!commands.length) return HELP;
  const width = Math.max(...commands.map(([name]) => name.length));
  return `${HELP}
${extension!.name} ${extension!.version} adds
${commands.map(([name, command]) => `  ${name.padEnd(width + 2)}${command.description}`).join("\n")}
`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), { booleans: BOOLEAN_FLAGS });
  const json = flagBool(args, "json");
  const home = flagString(args, "home");

  if (args.flags.has("version") || args.command === "version") {
    console.log(version);
    return 0;
  }
  if (!args.command || args.command === "help") {
    console.log(await fullHelp());
    return 0;
  }
  if (args.flags.has("help")) {
    if (COMMAND_HELP[args.command]) {
      console.log(COMMAND_HELP[args.command]);
      return 0;
    }
    const { loadExtension } = await import("../extension-loader.ts");
    const { extension } = await loadExtension().catch(() => ({ extension: null }));
    const command = extension?.commands?.[args.command];
    if (command) {
      // The command prints its own usage when called with nothing it understands.
      await command.run({ positional: ["--help"], flags: new Map(), dataDir: "" });
      return 0;
    }
    console.log(await fullHelp());
    return 0;
  }

  switch (args.command) {
    case "doctor": {
      const { doctor } = await import("./doctor.ts");
      return doctor(home, json, flagBool(args, "live"));
    }
    case "init": {
      const { init } = await import("./init.ts");
      return init({
        home,
        json,
        workspace: flagString(args, "workspace"),
        workspaceName: flagString(args, "name"),
        key: flagString(args, "key"),
      });
    }
    case "start":
    case "status":
    case "key":
    case "workspace":
    case "run":
    case "approve":
    case "deny":
    case "service":
    case "logs": {
      const commands = await import("./commands.ts");
      return commands[args.command](args);
    }
    default: {
      // An installed extension may add commands, e.g. `portrail relay`.
      const { loadExtension } = await import("../extension-loader.ts");
      const { extension } = await loadExtension();
      const command = extension?.commands?.[args.command];
      if (command) {
        const { dataDirectory, ensurePrivateDirectory } = await import(
          "../store/paths.ts"
        );
        return command.run({
          positional: args.positional,
          flags: args.flags,
          dataDir: ensurePrivateDirectory(dataDirectory(home)),
        });
      }
      throw new PortrailError(
        400,
        "UNKNOWN_COMMAND",
        `Unknown command "${args.command}". Run \`portrail --help\`.`,
      );
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof PortrailError) {
    console.error(`portrail: ${error.message}`);
  } else {
    console.error(`portrail: ${(error as Error).message ?? error}`);
    if (process.env.PORTRAIL_DEBUG) console.error(error);
  }
  process.exitCode = 1;
}
