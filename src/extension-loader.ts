import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_MODULE, type Extension } from "./extension.ts";

export interface LoadResult {
  extension: Extension | null;
  /** What loaded, or "not installed" — the one outcome that is not an error, because Pro is optional. */
  detail: string;
}

/**
 * Discover Portrail Pro if it is installed, or load the extension `PORTRAIL_EXTENSION`
 * names. Absence of an optional package is fine. An extension that is present — or
 * explicitly configured — and cannot load is not: the daemon must not start with the
 * built-in rules in place of the policy the operator meant to run.
 *
 * The specifier goes through a variable on purpose: the free core must compile and
 * ship without the proprietary package present, so it cannot be a static import.
 */
export async function loadExtension(): Promise<LoadResult> {
  const configured = process.env.PORTRAIL_EXTENSION;
  const specifier: string = configured
    ? pathToFileURL(resolve(configured)).href
    : EXTENSION_MODULE;
  let module: unknown;
  try {
    module = await import(specifier);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const notFound = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
    if (notFound && !configured) return { extension: null, detail: "not installed" };
    const message = (error as Error).message ?? String(error);
    throw new Error(
      configured
        ? `PORTRAIL_EXTENSION=${configured} ${notFound ? "was not found" : `failed to load: ${message}`}. Fix the path or unset PORTRAIL_EXTENSION.`
        : `Portrail Pro is installed but failed to load: ${message}. Reinstall or remove it; Portrail does not start with a broken extension in place.`,
    );
  }

  const candidate =
    (module as { default?: unknown }).default ??
    (module as { extension?: unknown }).extension ??
    module;

  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as Extension).name !== "string"
  )
    throw new Error(
      `${configured ?? EXTENSION_MODULE} did not export a Portrail extension.`,
    );

  const extension = candidate as Extension;
  return { extension, detail: `${extension.name} ${extension.version}` };
}
