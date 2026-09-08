// Registers the "@/..." alias resolver for the Node test runner.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-loader.mjs", pathToFileURL(import.meta.dirname + "/"));
