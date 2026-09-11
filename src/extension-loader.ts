import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_MODULE, type Extension } from "./extension.ts";

export interface LoadResult {
  extension: Extension | null;
  /** Why nothing loaded, when nothing loaded. Not an error — Pro is optional. */
  detail: string;
}

/**
 * Discover Portrail Pro if it is installed.
 *
 * The specifier goes through a variable on purpose: the free core must compile and
 * ship without the proprietary package present, so it cannot be a static import.
 */
export async function loadExtension(): Promise<LoadResult> {
  // PORTRAIL_EXTENSION points at a module path, so an extension can be loaded from a
  // custom location — a source checkout, or a different install prefix.
  const specifier: string = process.env.PORTRAIL_EXTENSION
    ? pathToFileURL(resolve(process.env.PORTRAIL_EXTENSION)).href
    : EXTENSION_MODULE;
  let module: unknown;
  try {
    module = await import(specifier);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      return { extension: null, detail: "not installed" };
    return {
      extension: null,
      detail: `installed but failed to load: ${(error as Error).message}`,
    };
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
    return {
      extension: null,
      detail: `${specifier} did not export a Portrail extension`,
    };

  const extension = candidate as Extension;
  return { extension, detail: `${extension.name} ${extension.version}` };
}
